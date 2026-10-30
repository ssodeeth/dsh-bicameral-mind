/**
 * Runtime orchestration for Bicameral Mind.
 *
 * Responsibilities:
 *  - hold the normalized settings and the per-session two-voice state;
 *  - run the examiner (and the actor's rebuttal / the examiner's final verdict)
 *    through `voice.js`, each voice on its own route;
 *  - turn observations into model-visible material: the `bicameral` tool result,
 *    the automatic `〔右脑·校正〕` message admitted at a step boundary, and the
 *    end-of-turn convergence gate.
 *
 * The automatic review deliberately runs at `agent/pre-step`, not in
 * `tools/post-execute`: a model call inside the tool commit path would delay
 * every result in the batch and, if the user cancelled meanwhile, could turn an
 * already-successful tool result into `ABORTED`. At a step boundary the same
 * objection reaches the model one step later without touching the tool outcome.
 *
 * All model-visible material is produced either by a registered tool result or
 * by an identified user message, so a replayed session remains consistent.
 *
 * @module dsh-bicameral-mind/runtime
 */
import {
	normalizeConfig,
	readSettings,
	resolveDshHome,
	writeSettings,
} from './config.js'
import {
	buildAdvocateReplyUser,
	buildAdvocateSystem,
	buildExaminerSystem,
	buildExaminerUser,
	buildVerdictUser,
	formatInterjection,
	formatToolResult,
	parseAdvocateReply,
	parseExaminerOutput,
} from './examiner.js'
import {
	detectLevel,
	LEVELS,
	presetPatch,
	REVIEW_ALL,
} from './levels.js'
import {
	BUDGET_PRESETS,
	budgetPresetPatch,
	detectBudgetTier,
} from './budget.js'
import { promptText } from './prompt.js'
import { BicameralStore } from './state.js'
import {
	createInjectedMessage,
	jsonPreview,
	messageOf,
	nowMs,
	str,
	textOfContent,
	truncate,
} from './util.js'
import { callFirstVoice, probeRoute, resolveVoiceRoutes } from './voice.js'

/** The single tool this plugin registers. */
export const TOOL_NAME = 'bicameral'

/** Review checkpoints. */
const STAGES = ['plan', 'act', 'checkpoint', 'finish']
const STAGE_SET = new Set(STAGES)

/** Coerce an unknown stage to a valid one. */
export function normalizeStage(value) {
	return STAGE_SET.has(value) ? value : 'act'
}

/**
 * Fail-safe reading of examiner output.
 *
 * A critic that silently certifies on unparseable output is worse than no
 * critic: a truncated JSON object can contain the word "pass" in prose. When
 * the output is not valid JSON, only an explicit revise/block fragment is
 * trusted; everything else is treated as an unresolved revision request.
 */
function secureVerdict(parsed, rawText) {
	if (parsed === undefined || parsed === null) return parsed
	if (parsed.parseMode !== 'heuristic') return parsed
	const match = /"verdict"\s*:\s*"(pass|revise|block)"/i.exec(typeof rawText === 'string' ? rawText : '')
	if (match !== null && match[1].toLowerCase() !== 'pass') return { ...parsed, verdict: match[1].toLowerCase() }
	const note = '右脑输出未能解析为 JSON（可能被截断），按保守处理'
	return {
		...parsed,
		verdict: 'revise',
		summary: truncate(`${note}：${parsed.summary}`, 400),
	}
}

/** Whether an agent is a delegated child rather than a top-level session. */
function isSubagent(agent) {
	try {
		return agent?.session?.header?.origin === 'subagent'
	} catch {
		return false
	}
}

/** Shell-ish tools whose command text can be classified read-only vs mutating. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'run_code'])

/** Markers that indicate a shell command may mutate state or reach outside. */
const SHELL_WRITE_MARKERS = new RegExp(
	[
		'\\bRemove-Item\\b', '\\bSet-Content\\b', '\\bAdd-Content\\b', '\\bOut-File\\b', '\\bNew-Item\\b',
		'\\bCopy-Item\\b', '\\bMove-Item\\b', '\\bRename-Item\\b', '\\bClear-Content\\b', '\\bSet-Item\\b',
		'\\bRemove-ItemProperty\\b', '\\bNew-ItemProperty\\b', '\\bStart-Process\\b', '\\bStop-Process\\b',
		'\\bInvoke-RestMethod\\b', '\\bInvoke-WebRequest\\b', '\\bcurl\\b', '\\bwget\\b',
		'\\bgit\\s+(?:commit|push|reset|checkout|merge|rebase|apply|clean)\\b',
		'\\b(?:npm|pnpm|yarn)\\s+(?:install|add|update|remove)\\b', '\\bpip\\s+install\\b',
		'\\bnode\\s+-e\\b', '\\bpython3?\\b', '\\.ps1\\b', '\\.cmd\\b', '\\.exe\\b',
		'>>?\\s*[^&|]',
	].join('|'),
	'i',
)

/**
 * Whether a shell command is clearly read-only.
 *
 * The examiner should not police `Get-Content` / `Test-Path`: treating every
 * shell call as consequential produced the false positive this guard removes
 * (a read command was reported as "wrote README"). Anything with a mutating
 * marker — or a shape this heuristic does not recognise — is reviewed normally.
 */
export function isClearlyReadOnlyShell(name, args) {
	if (!SHELL_TOOLS.has(name)) return false
	const command = typeof args?.command === 'string' ? args.command : ''
	if (command.trim().length === 0) return false
	return !SHELL_WRITE_MARKERS.test(command)
}

/**
 * Build the plugin runtime. One instance per mounted plugin row.
 *
 * @param ctx - host context.
 * @param config - the composition row's config object.
 * @returns the runtime facade consumed by the tool, command, web route, and mount.
 */
export function createRuntime(ctx, config) {
	const logger = ctx.logger
	const home = resolveDshHome(ctx)
	const store = new BicameralStore()
	let fileSettings = readSettings(home, logger)
	let settings = normalizeConfig(config, fileSettings)
	/** Last examiner route that actually produced text, tried first next time. */
	let lastGoodVoice

	/** Put the last successful examiner route at the front of the candidate list. */
	function preferLastGood(routes) {
		if (lastGoodVoice === undefined || !Array.isArray(routes) || routes.length < 2) return routes
		const index = routes.findIndex((route) => route.provider === lastGoodVoice.provider && route.model === lastGoodVoice.model)
		if (index <= 0) return routes
		return [routes[index], ...routes.slice(0, index), ...routes.slice(index + 1)]
	}

	/** Recompute the normalized view after a settings mutation. */
	function refresh() {
		settings = normalizeConfig(config, fileSettings)
	}

	/**
	 * Apply one settings mutation, persist it atomically, and refresh the live view.
	 * @returns `{ ok: true }` or `{ ok: false, error }` so the command can report a
	 * failed persistence instead of claiming success.
	 */
	function applyChange(mutate) {
		const next = JSON.parse(JSON.stringify(fileSettings ?? {}))
		mutate(next)
		fileSettings = next
		refresh()
		const written = writeSettings(home, fileSettings, logger)
		return written ? { ok: true } : { ok: false, error: '设置文件写入失败（内存中已生效，重启后会丢失）' }
	}

	/** Current normalized settings (live view). */
	function current() {
		return settings
	}

	/** Routes one voice may use for one agent, best first. */
	function routesFor(agent, role) {
		const voice = role === 'actor' ? settings.voices.actor : settings.voices.examiner
		const routes = resolveVoiceRoutes(ctx, agent, voice)
		if (role !== 'examiner' || agent?.id === undefined) return routes
		const override = store.examinerOverride(agent.id)
		if (override === null) return routes
		const key = `${override.provider}/${override.model}`
		return [{ provider: override.provider, model: override.model }, ...routes.filter((route) => `${route.provider}/${route.model}` !== key)]
	}

	/** Routes shown for one session, including its examiner override. */
	function effectiveRoutes(sessionId, role) {
		if (role !== 'examiner' || typeof sessionId !== 'string' || sessionId.length === 0) return routesFor(undefined, role)
		const override = store.examinerOverride(sessionId)
		const routes = routesFor(undefined, role)
		if (override === null) return routes
		const key = `${override.provider}/${override.model}`
		return [{ provider: override.provider, model: override.model }, ...routes.filter((route) => `${route.provider}/${route.model}` !== key)]
	}

	/** Set or clear the per-session examiner override. */
	function setSessionExaminer(sessionId, input) {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, message: 'sessionId is required' }
		const provider = readString(input?.provider, 100)
		const model = readString(input?.model, 200)
		if (provider.length === 0 && model.length === 0) {
			store.setExaminerOverride(sessionId, null)
			return { ok: true, override: null, routes: effectiveRoutes(sessionId, 'examiner').map((route) => `${route.provider}/${route.model}`) }
		}
		if (provider.length === 0 || model.length === 0) return { ok: false, message: 'provider 和 model 必须同时填写或同时留空' }
		const override = store.setExaminerOverride(sessionId, { provider, model })
		return { ok: true, override, routes: effectiveRoutes(sessionId, 'examiner').map((route) => `${route.provider}/${route.model}`) }
	}

	/** Compact description of one voice's route for commands and the panel. */
	function describeVoice(agent, role) {
		const routes = routesFor(agent, role)
		if (routes.length === 0) return '（无可用路由）'
		return routes.map((route) => `${route.provider}/${route.model}`).join('  →  ')
	}

	/** Record one transcript entry when a session is known. */
	function record(sessionId, entry) {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
		return store.recordEntry(sessionId, entry)
	}

	/** Build the unavailable result used when no voice can speak. */
	function unavailable(reason, depth, stage) {
		return {
			verdict: 'unavailable',
			summary: `右脑暂不可用：${truncate(reason, 300)}`,
			issues: [],
			questions: [],
			resolved: [],
			rounds: 0,
			depth,
			stage,
			transcript: { advocate: '', critique: '' },
			degraded: true,
			degradedReason: truncate(reason, 400),
			provider: '',
			model: '',
			attempts: [],
		}
	}

	/** Reset the per-turn cost counters when the turn advances. */
	function resetBudgetTurn(state) {
		if (state.budgetTurn === state.turn) return
		state.budgetTurn = state.turn
		state.budgetCalls = 0
		state.budgetFull = 0
		state.budgetTokens = 0
		state.budgetSkipped = 0
	}

	/**
	 * Reserve one review's estimated cost before any model call. A full debate is
	 * counted as three calls; the token estimate is conservative (maxTokens per
	 * call), so the limit is never silently exceeded.
	 */
	function reserveReviewBudget(sessionId, depth, tokensPerCall) {
		const cfg = settings
		if (!cfg.budget.enabled) return { ok: true }
		const state = sessionId === undefined ? undefined : store.peek(sessionId)
		if (state === undefined) return { ok: true }
		resetBudgetTurn(state)
		const calls = depth === 'full' ? 3 : 1
		const tokens = Math.max(1, tokensPerCall) * calls
		if (state.budgetCalls + calls > cfg.budget.maxCallsPerTurn) {
			return { ok: false, reason: `本轮审议调用预算已用完（上限 ${cfg.budget.maxCallsPerTurn} 次；一次完整辩论记 3 次）` }
		}
		if (depth === 'full' && state.budgetFull + 1 > cfg.budget.maxFullDebatesPerTurn) {
			return { ok: false, reason: `本轮完整辩论预算已用完（上限 ${cfg.budget.maxFullDebatesPerTurn} 次）` }
		}
		if (state.budgetTokens + tokens > cfg.budget.maxTokensPerTurn) {
			return { ok: false, reason: `本轮 token 预算已用完（估算上限 ${cfg.budget.maxTokensPerTurn}）` }
		}
		state.budgetCalls += calls
		state.budgetFull += depth === 'full' ? 1 : 0
		state.budgetTokens += tokens
		return { ok: true }
	}

	/** Human-readable cost guardrail state, including this turn's usage. */
	function budgetText(agent) {
		const cfg = settings
		const tier = detectBudgetTier(cfg.budget)
		const meta = BUDGET_PRESETS.find((preset) => preset.id === tier)
		const lines = [`成本护栏：${cfg.budget.enabled ? `开（${meta ? meta.title : '自定义'}）` : '关'}`]
		if (cfg.budget.enabled) {
			lines.push(`  每轮：≤ ${cfg.budget.maxCallsPerTurn} 次调用（完整辩论记 3 次） / ≤ ${cfg.budget.maxFullDebatesPerTurn} 次完整辩论 / ≈${cfg.budget.maxTokensPerTurn} tokens`)
		}
		const state = agent?.id === undefined ? undefined : store.peek(agent.id)
		if (state !== undefined) {
			resetBudgetTurn(state)
			lines.push(`  本轮已用：${state.budgetCalls} 次调用 / ${state.budgetFull} 次完整辩论 / ≈${state.budgetTokens} tokens${state.budgetSkipped > 0 ? `（拦截 ${state.budgetSkipped} 次）` : ''}`)
		}
		return lines.join('\n')
	}

	/**
	 * Run one full review.
	 *
	 * `quick` asks the examiner once. `full` adds the actor's rebuttal round and
	 * the examiner's final verdict: the actor argues on its own route (the
	 * session's model by default), the examiner judges on its own route, so the
	 * two voices are independent in both prompt and model.
	 */
	async function review(params) {
		const cfg = settings
		const stage = normalizeStage(params.stage)
		const depth = params.depth === 'full' || (params.depth === undefined && cfg.tool.fullStages.includes(stage)) ? 'full' : 'quick'
		const sessionId = typeof params.agent?.id === 'string' ? params.agent.id : undefined
		const state = sessionId === undefined ? undefined : store.peek(sessionId)
		const task = str(params.task) || (state?.task ?? '')
		const latest = state?.latestHuman ?? ''
		// 锚点是会话最初的目标；最新用户消息单独附上，供右脑判断「用户是不是改了口径」，
		// 而不是让它悄悄替换掉原始目标。
		const taskForPrompt = latest.length > 0 && latest !== task ? `${task}\n\n（用户最新消息：${truncate(latest, 500)}）` : task
		const claim = str(params.claim)
		let evidence = str(params.evidence)
		// 只有「刚做完一个动作」的 act 阶段，最近动作才是本次审议的对象；
		// plan/checkpoint/finish 省略证据时附上旧动作只会误导右脑。
		if (evidence.length === 0 && sessionId !== undefined && stage === 'act') evidence = store.evidenceFromActions(sessionId)
		if (evidence.length === 0) evidence = '（没有提供证据）'
		const priorIssues = sessionId === undefined ? '' : store.pendingIssuesText(sessionId)
		const language = cfg.language

		if (sessionId !== undefined && state !== undefined && state.reviewing === true && params.preGuarded !== true) {
			return unavailable('同一会话已有一次审议在进行', depth, stage)
		}
		if (!cfg.enabled) return unavailable('二分心智当前已关闭（/bicameral on 可开启）', depth, stage)
		const estimateTokens = Number.isSafeInteger(params.maxTokens) && params.maxTokens > 0
			? params.maxTokens
			: (depth === 'full' ? cfg.voices.examiner.maxTokensFull : cfg.voices.examiner.maxTokensQuick)
		const budget = reserveReviewBudget(sessionId, depth, estimateTokens)
		if (!budget.ok) {
			if (state !== undefined) state.budgetSkipped += 1
			return unavailable(budget.reason, depth, stage)
		}

		const examinerRoutes = preferLastGood(routesFor(params.agent, 'examiner'))
		const actorRoutes = routesFor(params.agent, 'actor')
		if (examinerRoutes.length === 0) {
			const result = unavailable('没有可用的右脑模型路由', depth, stage)
			record(sessionId, { origin: params.origin, stage, verdict: result.verdict, summary: result.summary, issues: [], toolName: params.toolName })
			return result
		}

		const examinerVoice = cfg.voices.examiner
		const actorVoice = cfg.voices.actor
		const examinerSystem = buildExaminerSystem({ stage, language, maxIssues: cfg.maxIssues })
		const examinerUser = buildExaminerUser({
			stage,
			task: taskForPrompt,
			claim,
			evidence,
			priorIssues,
			rebuttal: str(params.rebuttal),
		})
		const quickTokens = Number.isSafeInteger(params.maxTokens) && params.maxTokens > 0 ? params.maxTokens : examinerVoice.maxTokensQuick

		if (state !== undefined && params.preGuarded !== true) state.reviewing = true
		try {
			const first = await callFirstVoice(ctx, examinerRoutes, {
				system: examinerSystem,
				user: examinerUser,
				maxTokens: quickTokens,
				temperature: examinerVoice.temperature,
				timeoutMs: params.timeoutMs ?? cfg.tool.timeoutMs,
				signal: params.signal,
				onAttempt: (route, failureResult) => {
					logger?.warn?.(`bicameral-mind: examiner route ${route.provider}/${route.model} failed: ${failureResult.error}`)
				},
			})
			if (!first.ok) {
				const result = unavailable(first.error, depth, stage)
				record(sessionId, {
					origin: params.origin,
					stage,
					verdict: result.verdict,
					summary: result.summary,
					issues: [],
					toolName: params.toolName,
					provider: '',
					model: '',
				})
				return result
			}

			let parsed = secureVerdict(parseExaminerOutput(first.text), first.text)
			if (typeof first.provider === 'string' && typeof first.model === 'string') {
				lastGoodVoice = { provider: first.provider, model: first.model }
			}
			const transcript = {
				advocate: claim.length > 0 ? claim : '（左脑未显式声明主张，仅提供了动作与证据）',
				critique: first.text,
			}
			let rounds = 1
			let used = { provider: first.provider, model: first.model }
			let degraded = false
			let degradedReason = ''

			if (depth === 'full' && parsed.issues.length > 0) {
				if (actorRoutes.length === 0) {
					degraded = true
					degradedReason = '左脑答辩路由不可用，采用首轮裁决'
				} else {
					const advocateSystem = buildAdvocateSystem({ language })
					const advocateUser = buildAdvocateReplyUser({
						task: taskForPrompt,
						claim: transcript.advocate,
						evidence,
						critique: first.text,
					})
					const reply = await callFirstVoice(ctx, actorRoutes, {
						system: advocateSystem,
						user: advocateUser,
						maxTokens: actorVoice.maxTokensFull,
						temperature: actorVoice.temperature,
						timeoutMs: params.timeoutMs ?? cfg.tool.timeoutMs,
						signal: params.signal,
						onAttempt: (route, failureResult) => {
							logger?.warn?.(`bicameral-mind: actor route ${route.provider}/${route.model} failed: ${failureResult.error}`)
						},
					})
					if (reply.ok) {
						transcript.reply = parseAdvocateReply(reply.text)
						rounds += 1
						const verdictUser = buildVerdictUser({
							task: taskForPrompt,
							claim: transcript.advocate,
							evidence,
							critique: first.text,
							reply: transcript.reply,
						})
						const final = await callFirstVoice(ctx, examinerRoutes, {
							system: examinerSystem,
							user: verdictUser,
							maxTokens: examinerVoice.maxTokensFull,
							temperature: examinerVoice.temperature,
							timeoutMs: params.timeoutMs ?? cfg.tool.timeoutMs,
							signal: params.signal,
						})
						if (final.ok) {
							const finalParsed = secureVerdict(parseExaminerOutput(final.text), final.text)
							if (finalParsed.parseMode === 'heuristic') {
								// 终裁不完整时保留首轮裁决，绝不用不可解析的输出放宽标准。
								degraded = true
								degradedReason = '终裁输出不可解析，保留首轮裁决'
							} else {
								parsed = finalParsed
								transcript.final = final.text
								rounds += 1
								used = { provider: final.provider, model: final.model }
							}
						} else {
							degraded = true
							degradedReason = '终裁调用失败，采用首轮裁决'
						}
					} else {
						degraded = true
						degradedReason = '左脑答辩调用失败，采用首轮裁决'
					}
				}
			}

			if (sessionId !== undefined) {
				store.recordReviewIssues(sessionId, {
					verdict: parsed.verdict,
					stage,
					issues: parsed.issues,
					resolved: parsed.resolved,
					deliberate: params.origin === 'tool' || params.origin === 'command',
					turn: state?.turn,
					step: state?.step,
				})
			}
			record(sessionId, {
				origin: params.origin,
				stage,
				verdict: parsed.verdict,
				summary: parsed.summary,
				issues: parsed.issues,
				questions: parsed.questions,
				transcript,
				toolName: params.toolName,
				provider: used.provider,
				model: used.model,
			})
			return {
				verdict: parsed.verdict,
				summary: parsed.summary,
				issues: parsed.issues,
				questions: parsed.questions,
				resolved: parsed.resolved,
				rounds,
				depth,
				stage,
				transcript,
				degraded,
				degradedReason,
				provider: used.provider,
				model: used.model,
				attempts: first.attempts,
			}
		} catch (error) {
			logger?.warn?.(`bicameral-mind: review failed: ${messageOf(error)}`)
			const result = unavailable(messageOf(error), depth, stage)
			record(sessionId, {
				origin: params.origin,
				stage,
				verdict: result.verdict,
				summary: result.summary,
				issues: [],
				toolName: params.toolName,
			})
			return result
		} finally {
			if (state !== undefined && params.preGuarded !== true) state.reviewing = false
		}
	}

	/** Capture the current task anchor and turn from an admitted step batch. */
	function captureTask(payload) {
		const agent = payload?.agent
		if (agent?.id === undefined) return
		const state = store.stateFor(agent.id)
		const turn = Number.isSafeInteger(payload.turn) ? payload.turn : state.turn
		if (state.turn !== turn) {
			state.turn = turn
			state.autoTurn = turn
			state.autoCount = 0
		}
		state.step = Number.isSafeInteger(payload.step) ? payload.step : state.step
		const messages = Array.isArray(payload.messages) ? payload.messages : []
		for (const message of messages) {
			if (message === null || typeof message !== 'object') continue
			if (message.source?.kind !== 'user') continue
			const text = textOfContent(message.content).trim()
			if (text.length > 0) store.recordHumanTask(agent.id, text, turn)
		}
	}

	/**
	 * Remember one completed tool call and, when it is consequential, mark it as
	 * awaiting the next step boundary. No model call happens here: `tools/result`
	 * is an emit and must not block the tool pipeline.
	 */
	function onToolResult(exec, result) {
		const agent = exec?.agent
		if (agent?.id === undefined) return
		if (exec.name === TOOL_NAME) return
		if (exec.parent !== undefined) return
		store.recordAction(agent.id, {
			name: exec.name,
			arguments: jsonPreview(exec.arguments, 800),
			result: truncate(textOfContent(result?.content), 800),
			isError: result?.isError === true,
		})
		const cfg = settings
		if (!cfg.enabled || !cfg.autoReview.enabled) return
		if (!cfg.autoReview.tools.includes(REVIEW_ALL) && !cfg.autoReview.tools.includes(exec.name)) return
		if (cfg.autoReview.shellReadGuard && isClearlyReadOnlyShell(exec.name, exec.arguments)) return
		if (isSubagent(agent) && cfg.autoReview.subagents !== true) return
		if (result?.isError === true && cfg.autoReview.includeErrors === false) return
		store.markTrigger(agent.id, exec.name)
	}

	/** Whether the automatic examiner may speak for this session right now. */
	function autoBudget(state) {
		const cfg = settings
		if (!cfg.enabled || !cfg.autoReview.enabled) return false
		if (state.reviewing === true) return false
		if (state.task.length === 0) return false
		if (state.autoTurn !== state.turn) {
			state.autoTurn = state.turn
			state.autoCount = 0
		}
		if (state.autoCount >= cfg.autoReview.maxPerTurn) return false
		if (nowMs() - state.lastAutoAt < cfg.autoReview.cooldownMs) return false
		return true
	}

	/**
	 * Consume the pending trigger and, if the examiner objects, build the user
	 * message that the next step must answer.
	 */
	async function maybeAutoReview(payload) {
		const agent = payload?.agent
		if (agent?.id === undefined) return undefined
		const state = store.peek(agent.id)
		if (state === undefined) return undefined
		const trigger = store.takeTrigger(agent.id)
		if (trigger === undefined) return undefined
		if (payload.signal?.aborted === true) return undefined
		const cfg = settings
		if (!autoBudget(state)) return undefined
		state.autoCount += 1
		state.lastAutoAt = nowMs()
		const evidence = [
			`刚完成的动作：${trigger.name}`,
			`当前进度：第 ${state.turn} 轮 / step ${state.step}`,
			store.evidenceFromActions(agent.id, 3),
			'这次只审查刚完成的动作及其直接后果：先判断是否真的产生了副作用（只读查询不应被当作写入/删除），再判断它与用户任务目标的关系。',
			'此前未确认的问题如果已经在最近证据里被修复，请在裁决的 resolved 中列出它（引用问题原文），不要再次列进 issues，也不要因此给 revise。',
		].join('\n')
		const outcome = await review({
			agent,
			stage: 'act',
			claim: '',
			evidence,
			task: state.task,
			depth: cfg.tool.defaultDepth,
			signal: payload.signal,
			origin: 'auto',
			toolName: trigger.name,
			timeoutMs: cfg.autoReview.timeoutMs,
			maxTokens: cfg.autoReview.maxTokens,
		})
		if (outcome.verdict !== 'revise' && outcome.verdict !== 'block') {
			if (outcome.verdict === 'pass' && cfg.autoReview.logPasses) {
				store.recordEntry(agent.id, {
					origin: 'auto',
					stage: 'act',
					verdict: 'pass',
					summary: outcome.summary,
					issues: [],
					toolName: trigger.name,
				})
			}
			return undefined
		}
		const text = formatInterjection({
			stage: 'act',
			toolName: trigger.name,
			verdict: outcome.verdict,
			summary: outcome.summary,
			issues: outcome.issues,
		})
		return text.length === 0 ? undefined : createInjectedMessage(text)
	}

	/**
	 * The `agent/pre-step` entry point: capture the task, then admit the
	 * examiner's objection into the batch that is about to become a model step.
	 * Nothing here runs inside the tool commit path.
	 */
	async function handlePreStep(payload, next) {
		try {
			captureTask(payload)
		} catch {
			/* task capture is best effort */
		}
		const decision = await next()
		try {
			if (decision === undefined || decision === null || decision.kind !== 'enter') return decision
			const message = await maybeAutoReview(payload)
			if (message === undefined) return decision
			return { ...decision, messages: [...decision.messages, message] }
		} catch (error) {
			logger?.warn?.(`bicameral-mind: auto review skipped: ${messageOf(error)}`)
			return decision
		}
	}

	/** Final answer text of one session, for the end-of-turn gate. */
	function lastAssistantText(agent) {
		try {
			const messages = agent?.session?.deriveMessages?.()
			if (!Array.isArray(messages)) return ''
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				const message = messages[index]
				if (message?.role !== 'assistant') continue
				const text = textOfContent(message.content).trim()
				if (text.length > 0) return text
			}
		} catch {
			/* derivation is best effort */
		}
		return ''
	}

	/** End-of-turn convergence gate: unresolved examiner issues must be answered. */
	async function onTurnStopping(payload) {
		const cfg = settings
		if (!cfg.enabled || !cfg.autoReview.enabled || !cfg.autoReview.finishGate) return
		const agent = payload?.agent
		if (agent?.id === undefined) return
		if (isSubagent(agent) && cfg.autoReview.subagents !== true) return
		const state = store.peek(agent.id)
		if (state === undefined) return
		if (state.pendingIssues.length === 0 && cfg.autoReview.finishAlways !== true) return
		if (state.reviewing === true) return
		const turn = Number.isSafeInteger(payload.turn) ? payload.turn : state.turn
		if (state.finishGateTurn === turn) return
		const finalText = lastAssistantText(agent)
		if (finalText.length === 0) return
		state.finishGateTurn = turn
		state.reviewing = true
		try {
			const pending = store.pendingIssuesText(agent.id)
			const evidence = cfg.autoReview.finishAlways === true && pending.length === 0
				? [
						`左脑的最终回答：\n${truncate(finalText, 1600)}`,
						`本轮没有未决问题；请独立判断任务是否真的完成、是否有未经证实的断言、是否有遗漏的验证。`,
					].join('\n\n')
				: [
						`左脑的最终回答：\n${truncate(finalText, 1600)}`,
						`此前右脑提出、但尚未确认处理的问题：\n${pending}`,
						`请判断最终回答是否已实际回应并解决这些问题（不是口头承认）。已解决的旧问题请在 resolved 中列出，未解决的再列进 issues。`,
					].join('\n\n')
			const outcome = await review({
				agent,
				stage: 'finish',
				claim: '我认为任务已经完成，准备结束本轮。',
				evidence,
				task: state.task,
				depth: cfg.autoReview.finishAlways === true ? 'full' : 'quick',
				signal: payload.signal,
				origin: 'auto',
				toolName: '收尾检查',
				timeoutMs: cfg.autoReview.timeoutMs,
				maxTokens: cfg.autoReview.maxTokens,
				preGuarded: true,
			})
			if (outcome.verdict !== 'revise' && outcome.verdict !== 'block') return
			if (payload.signal?.aborted === true) return
			const text = formatInterjection({
				stage: 'finish',
				toolName: '收尾检查',
				verdict: outcome.verdict,
				summary: outcome.summary,
				issues: outcome.issues,
			})
			if (text.length === 0) return
			agent.steer(createInjectedMessage(text))
		} catch (error) {
			logger?.warn?.(`bicameral-mind: finish gate skipped: ${messageOf(error)}`)
		} finally {
			state.reviewing = false
		}
	}

	/** Human-readable status for `/bicameral status`. */
	function statusText(agent) {
		const cfg = settings
		const state = agent?.id === undefined ? undefined : store.peek(agent.id)
		const level = detectLevel(cfg)
		const levelMeta = LEVELS.find((item) => item.id === level)
		const lines = [
			`二分心智：${cfg.enabled ? '已启用' : '已关闭'}`,
			`介入程度：${levelMeta ? `${levelMeta.title}（${level}）` : '自定义（custom）'}`,
			`左脑模型：${describeVoice(agent, 'actor')}（默认跟随会话路由）`,
			`右脑模型：${describeVoice(agent, 'examiner')}${cfg.voices.examiner.provider && cfg.voices.examiner.model ? '（已钉死）' : '（默认跟随会话路由，可用 /bicameral voice examiner <provider> <model> 指定不同模型）'}`,
			`自动插话：${cfg.autoReview.enabled ? '开' : '关'}，监视 ${cfg.autoReview.tools.includes(REVIEW_ALL) ? '全部工具' : cfg.autoReview.tools.join('/') || '（空）'}，冷却 ${cfg.autoReview.cooldownMs}ms，每轮上限 ${cfg.autoReview.maxPerTurn}`,
			budgetText(agent),
			`收尾闸门：${cfg.autoReview.finishGate ? (cfg.autoReview.finishAlways ? '开（每轮必审）' : '开（仅未决问题）') : '关'}；默认审议深度：${cfg.tool.defaultDepth}（完整审议阶段：${cfg.tool.fullStages.join('/') || '无'}）`,
		]
		if (state !== undefined) {
			lines.push(`当前任务锚点：${state.task.length > 0 ? truncate(state.task, 200) : '（尚未捕获用户任务）'}`)
			lines.push(`未决右脑问题：${state.pendingIssues.length} 条`)
			const last = store.lastEntry(agent.id)
			if (last !== undefined) lines.push(`最近裁决：${last.verdict} · ${truncate(last.summary, 160)}`)
		}
		return lines.join('\n')
	}

	/** Human-readable latest transcript for `/bicameral last`. */
	function lastText(agent) {
		if (agent?.id === undefined) return '当前没有会话上下文。'
		const entry = store.lastEntry(agent.id)
		if (entry === undefined) return '本会话还没有审议记录。'
		return formatToolResult({
			stage: entry.stage,
			verdict: entry.verdict,
			summary: entry.summary,
			issues: entry.issues,
			questions: entry.questions,
			transcript: entry.transcript,
			degraded: entry.verdict === 'unavailable',
			degradedReason: entry.verdict === 'unavailable' ? entry.summary : '',
		})
	}

	/** Probe every configured/available route for both voices. */
	async function probe(agent) {
		const groups = [
			['右脑 examiner', routesFor(agent, 'examiner')],
			['左脑 actor', routesFor(agent, 'actor')],
		]
		const lines = []
		for (const [label, routes] of groups) {
			if (!Array.isArray(routes) || routes.length === 0) {
				lines.push(`${label}：无可用路由`)
				continue
			}
			lines.push(`${label}（${routes.length} 条）：`)
			for (const route of routes) {
				const result = await probeRoute(ctx, route, Math.min(30000, settings.tool.timeoutMs))
				if (result.ok) lines.push(`  ✔ ${route.provider}/${route.model} · ${result.elapsedMs}ms`)
				else lines.push(`  ✘ ${route.provider}/${route.model} · ${result.elapsedMs}ms · ${result.error}`)
			}
		}
		return lines.join('\n')
	}

	/** Cached provider/model catalog for the settings page. */
	let modelCatalog
	let modelCatalogAt = 0

	/** Read one bounded string field. */
	function readString(value, max = 200) {
		const text = typeof value === 'string' ? value.trim() : ''
		return text.length > max ? text.slice(0, max) : text
	}

	/** Read one bounded integer field. */
	function readInt(value, min, max) {
		const number = typeof value === 'number' ? value : Number.NaN
		if (!Number.isFinite(number)) return undefined
		const rounded = Math.trunc(number)
		return rounded < min || rounded > max ? undefined : rounded
	}

	/** Read a candidate list, bounded and de-duplicated. */
	function readCandidates(value) {
		if (!Array.isArray(value)) return undefined
		const out = []
		const seen = new Set()
		for (const item of value.slice(0, 8)) {
			const provider = readString(item?.provider, 100)
			const model = readString(item?.model, 200)
			if (provider.length === 0 || model.length === 0) continue
			const key = `${provider}\u0000${model}`
			if (seen.has(key)) continue
			seen.add(key)
			out.push({ provider, model })
		}
		return out
	}

	/** Read a list of tool names. */
	function readToolList(value) {
		if (!Array.isArray(value)) return undefined
		const out = []
		for (const item of value.slice(0, 40)) {
			const name = readString(item, 80)
			if (name.length > 0 && !out.includes(name)) out.push(name)
		}
		return out
	}

	/** Deep-merge a validated patch into the settings-file layer. */
	function mergeInto(target, patch) {
		for (const [key, value] of Object.entries(patch)) {
			if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
				if (target[key] === null || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {}
				mergeInto(target[key], value)
			} else {
				target[key] = value
			}
		}
	}

	/** The editable projection of the live settings (no secrets). */
	function editableSettings() {
		const cfg = settings
		const role = (voice) => ({
			provider: voice.provider,
			model: voice.model,
			reasoningEffort: voice.reasoningEffort,
			candidates: voice.candidates.map((candidate) => ({ provider: candidate.provider, model: candidate.model })),
		})
		return {
			enabled: cfg.enabled,
			language: cfg.language,
			voices: { actor: role(cfg.voices.actor), examiner: role(cfg.voices.examiner) },
			autoReview: {
				enabled: cfg.autoReview.enabled,
				tools: [...cfg.autoReview.tools],
				cooldownMs: cfg.autoReview.cooldownMs,
				maxPerTurn: cfg.autoReview.maxPerTurn,
				timeoutMs: cfg.autoReview.timeoutMs,
				maxTokens: cfg.autoReview.maxTokens,
				includeErrors: cfg.autoReview.includeErrors,
				subagents: cfg.autoReview.subagents,
				logPasses: cfg.autoReview.logPasses,
				finishGate: cfg.autoReview.finishGate,
				finishAlways: cfg.autoReview.finishAlways,
				shellReadGuard: cfg.autoReview.shellReadGuard,
			},
			tool: { defaultDepth: cfg.tool.defaultDepth, fullStages: [...cfg.tool.fullStages] },
			budget: {
				enabled: cfg.budget.enabled,
				maxCallsPerTurn: cfg.budget.maxCallsPerTurn,
				maxFullDebatesPerTurn: cfg.budget.maxFullDebatesPerTurn,
				maxTokensPerTurn: cfg.budget.maxTokensPerTurn,
			},
		}
	}

	/** Validate and persist one settings-page patch. */
	function applyEditablePatch(patch) {
		if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
			return { ok: false, message: 'patch 必须是一个对象' }
		}
		const errors = []
		const next = {}
		if ('enabled' in patch) {
			if (typeof patch.enabled !== 'boolean') errors.push('enabled 必须是布尔值')
			else next.enabled = patch.enabled
		}
		if ('language' in patch) {
			const language = readString(patch.language, 10)
			if (!['zh', 'en', 'auto'].includes(language)) errors.push('language 必须是 zh / en / auto')
			else next.language = language
		}
		if ('intervention' in patch) {
			const intervention = readString(patch.intervention, 20)
			if (!['off', 'advisory', 'balanced', 'strict', 'paranoid', 'custom'].includes(intervention)) {
				errors.push('intervention 必须是 off / advisory / balanced / strict / paranoid / custom')
			} else {
				next.intervention = intervention
			}
		}
		if ('maxIssues' in patch) {
			const maxIssues = readInt(patch.maxIssues, 1, 5)
			if (maxIssues === undefined) errors.push('maxIssues 必须在 1..5 之间')
			else next.maxIssues = maxIssues
		}
		if (patch.voices !== undefined) {
			if (patch.voices === null || typeof patch.voices !== 'object' || Array.isArray(patch.voices)) {
				errors.push('voices 必须是对象')
			} else {
				next.voices = {}
				for (const roleName of ['actor', 'examiner']) {
					if (patch.voices[roleName] === undefined) continue
					const raw = patch.voices[roleName]
					if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
						errors.push(`voices.${roleName} 必须是对象`)
						continue
					}
					const value = {}
					if ('provider' in raw) value.provider = readString(raw.provider, 100)
					if ('model' in raw) value.model = readString(raw.model, 200)
					if ('reasoningEffort' in raw) value.reasoningEffort = readString(raw.reasoningEffort, 60)
					if ('candidates' in raw) {
						const candidates = readCandidates(raw.candidates)
						if (candidates === undefined) errors.push(`voices.${roleName}.candidates 必须是数组`)
						else value.candidates = candidates
					}
					const providerValue = value.provider ?? ''
					const modelValue = value.model ?? ''
					if (value.provider !== undefined || value.model !== undefined) {
						if ((providerValue.length === 0) !== (modelValue.length === 0)) {
							errors.push(`voices.${roleName} 的 provider 与 model 必须同时填写或同时留空`)
						}
					}
					next.voices[roleName] = value
				}
			}
		}
		if (patch.autoReview !== undefined) {
			const raw = patch.autoReview
			if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
				errors.push('autoReview 必须是对象')
			} else {
				const value = {}
				for (const key of ['enabled', 'includeErrors', 'subagents', 'logPasses', 'finishGate', 'finishAlways', 'shellReadGuard']) {
					if (!(key in raw)) continue
					if (typeof raw[key] !== 'boolean') errors.push(`autoReview.${key} 必须是布尔值`)
					else value[key] = raw[key]
				}
				if ('tools' in raw) {
					const tools = readToolList(raw.tools)
					if (tools === undefined) errors.push('autoReview.tools 必须是数组')
					else value.tools = tools
				}
				for (const [key, min, max] of [['cooldownMs', 0, 600000], ['maxPerTurn', 1, 50], ['timeoutMs', 2000, 120000], ['maxTokens', 200, 4000]]) {
					if (!(key in raw)) continue
					const number = readInt(raw[key], min, max)
					if (number === undefined) errors.push(`autoReview.${key} 必须在 ${min}..${max} 之间`)
					else value[key] = number
				}
				next.autoReview = value
			}
		}
		if (patch.tool !== undefined) {
			const raw = patch.tool
			if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
				errors.push('tool 必须是对象')
			} else {
				const value = {}
				if ('defaultDepth' in raw) {
					if (raw.defaultDepth !== 'quick' && raw.defaultDepth !== 'full') errors.push('tool.defaultDepth 必须是 quick 或 full')
					else value.defaultDepth = raw.defaultDepth
				}
				if ('fullStages' in raw) {
					const stages = Array.isArray(raw.fullStages)
						? raw.fullStages.filter((stage) => ['plan', 'act', 'checkpoint', 'finish'].includes(stage))
						: undefined
					if (stages === undefined) errors.push('tool.fullStages 必须是阶段数组')
					else value.fullStages = stages
				}
				next.tool = value
			}
		}
		if (patch.budget !== undefined) {
			const raw = patch.budget
			if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
				errors.push('budget 必须是对象')
			} else {
				const value = {}
				if ('enabled' in raw) {
					if (typeof raw.enabled !== 'boolean') errors.push('budget.enabled 必须是布尔值')
					else value.enabled = raw.enabled
				}
				for (const [key, min, max] of [['maxCallsPerTurn', 1, 1000], ['maxFullDebatesPerTurn', 0, 200], ['maxTokensPerTurn', 1000, 2000000]]) {
					if (!(key in raw)) continue
					const number = readInt(raw[key], min, max)
					if (number === undefined) errors.push(`budget.${key} 必须在 ${min}..${max} 之间`)
					else value[key] = number
				}
				next.budget = value
			}
		}
		if (errors.length > 0) return { ok: false, message: errors.join('；') }
		const outcome = applyChange((settingsFile) => mergeInto(settingsFile, next))
		return outcome.ok ? { ok: true } : outcome
	}

	/**
	 * Apply one intervention level: the preset fully replaces every knob the
	 * level controls and is persisted in the plugin settings file.
	 */
	function applyLevel(levelId) {
		const id = typeof levelId === 'string' ? levelId.trim().toLowerCase() : ''
		const patch = presetPatch(id)
		if (patch === undefined) {
			return { ok: false, message: `未知档位：${id || '（空）'}；可选 ${LEVELS.map((level) => level.id).join(' / ')}` }
		}
		const outcome = applyChange((settingsFile) => mergeInto(settingsFile, patch))
		return outcome.ok ? { ok: true, level: id } : outcome
	}

	/**
	 * Apply one cost-guardrail preset (relaxed / standard / frugal), persisted to
	 * the settings file. A custom numeric patch goes through applyEditablePatch.
	 */
	function applyBudgetPreset(tier) {
		const id = typeof tier === 'string' ? tier.trim().toLowerCase() : ''
		const patch = budgetPresetPatch(id)
		if (patch === undefined) {
			return { ok: false, message: `未知成本档位：${id || '（空）'}；可选 ${BUDGET_PRESETS.map((preset) => preset.id).join(' / ')}` }
		}
		const outcome = applyChange((settingsFile) => mergeInto(settingsFile, patch))
		return outcome.ok ? { ok: true, tier: id } : outcome
	}

	/** Human-driven resolution of outstanding issues (Web "inner dialogue" view). */
	function resolveIssues(sessionId, problems) {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, message: 'sessionId is required' }
		const state = store.peek(sessionId)
		if (state === undefined) return { ok: false, message: 'session not found' }
		const texts = Array.isArray(problems)
			? problems.filter((text) => typeof text === 'string' && text.trim().length > 0).map((text) => text.trim()).slice(0, 20)
			: []
		return { ok: true, ...store.resolveIssues(sessionId, texts) }
	}

	/** Human-driven "clear all" for one session. */
	function clearIssues(sessionId) {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, message: 'sessionId is required' }
		const state = store.peek(sessionId)
		if (state === undefined) return { ok: false, message: 'session not found' }
		return { ok: true, ...store.clearIssues(sessionId) }
	}

	/** Provider/model catalog for the settings page, cached briefly. */
	async function availableModels(force = false) {
		if (force !== true && modelCatalog !== undefined && nowMs() - modelCatalogAt < 60000) return modelCatalog
		const llm = ctx.get?.('llm')
		let infos = []
		try {
			infos = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
		} catch {
			infos = []
		}
		// Discover providers in parallel with a short per-provider deadline; a slow
		// or broken adapter must not leave the picker stuck for tens of seconds.
		const entries = Array.isArray(infos) ? infos : []
		const providers = await Promise.all(
			entries.map(async (info) => {
				const provider = typeof info?.id === 'string' ? info.id : ''
				if (provider.length === 0) return undefined
				let models = []
				try {
					const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), 2500))
					const listed = await Promise.race([llm.listModels(provider), timeout])
					if (Array.isArray(listed)) {
						models = listed
							.map((model) => ({ id: String(model?.id ?? ''), name: String(model?.name ?? model?.id ?? '') }))
							.filter((model) => model.id.length > 0)
					}
				} catch {
					models = []
				}
				return { provider, name: typeof info?.name === 'string' ? info.name : provider, models }
			}),
		)
		modelCatalog = { providers: providers.filter((entry) => entry !== undefined), fetchedAt: nowMs() }
		modelCatalogAt = nowMs()
		return modelCatalog
	}

	/** Probe one explicit route from the settings page. */
	async function probeVoice(route) {
		const provider = readString(route?.provider, 100)
		const model = readString(route?.model, 200)
		if (provider.length === 0 || model.length === 0) return { ok: false, error: 'provider 和 model 都必须填写', elapsedMs: 0 }
		const result = await probeRoute(ctx, { provider, model }, 20000)
		return { ok: result.ok === true, elapsedMs: result.elapsedMs, error: result.ok ? '' : result.error }
	}

	/** Everything the settings page needs for one render. */
	function configView() {
		return {
			settings: editableSettings(),
			level: detectLevel(settings),
			levels: LEVELS.map((level) => ({ id: level.id, title: level.title, description: level.description })),
			budgetTier: detectBudgetTier(settings.budget),
			budgetPresets: BUDGET_PRESETS.map((preset) => ({ ...preset, values: { ...preset.values } })),
			routes: {
				actor: routesFor(undefined, 'actor').map((route) => `${route.provider}/${route.model}`),
				examiner: routesFor(undefined, 'examiner').map((route) => `${route.provider}/${route.model}`),
			},
			settingsPath: '$DSH_HOME/storages/bicameral-mind/settings.json',
		}
	}

	/** The diagnostics snapshot consumed by one session's Web panel. */
	function snapshot(sessionId) {
		const state = sessionId === undefined ? undefined : store.peek(sessionId)
		if (state !== undefined) resetBudgetTurn(state)
		return {
			enabled: settings.enabled,
			language: settings.language,
			voices: {
				actor: {
					routes: routesFor(undefined, 'actor').map((route) => `${route.provider}/${route.model}`),
					pinned: settings.voices.actor.provider.length > 0 && settings.voices.actor.model.length > 0,
				},
				examiner: {
					routes: effectiveRoutes(sessionId, 'examiner').map((route) => `${route.provider}/${route.model}`),
					override: state?.examinerOverride ?? null,
					pinned: settings.voices.examiner.provider.length > 0 && settings.voices.examiner.model.length > 0,
				},
			},
			autoReview: {
				enabled: settings.autoReview.enabled,
				tools: settings.autoReview.tools,
				cooldownMs: settings.autoReview.cooldownMs,
				maxPerTurn: settings.autoReview.maxPerTurn,
				finishGate: settings.autoReview.finishGate,
			},
			budget: {
				...settings.budget,
				tier: detectBudgetTier(settings.budget),
				usage: state === undefined
					? undefined
					: { calls: state.budgetCalls, full: state.budgetFull, tokens: state.budgetTokens, skipped: state.budgetSkipped },
			},
			...store.snapshot(sessionId),
		}
	}

	return {
		ctx,
		store,
		current,
		refresh,
		applyChange,
		routesFor,
		describeVoice,
		review,
		statusText,
		lastText,
		probe,
		snapshot,
		editableSettings,
		applyEditablePatch,
		applyLevel,
		applyBudgetPreset,
		budgetText,
		resolveIssues,
		clearIssues,
		setSessionExaminer,
		availableModels,
		probeVoice,
		configView,
		promptText: () => promptText(settings),
		handlePreStep,
		onToolResult,
		onTurnStopping,
	}
}
