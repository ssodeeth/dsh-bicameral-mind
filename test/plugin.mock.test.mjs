/**
 * Wiring tests for the Bicameral Mind host plugin, run against a fake Cordis
 * context. They exercise the real runtime: tool registration, prompt section,
 * task capture, two independent voice routes, the automatic interjection, the
 * convergence gate, and the command surface.
 *
 * No Harness process is required; only `node --test`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

import { apply } from '../index.js'
import { buildCommand } from '../src/command.js'
import { createRuntime } from '../src/runtime.js'
import { buildBicameralTool } from '../src/tool.js'

/** A fake ctx that records registrations and can answer model calls. */
function createFakeCtx({ replies = () => '{"verdict":"pass","summary":"ok","issues":[],"questions":[]}', selection, webServer } = {}) {
	const records = {
		tools: [],
		sections: [],
		listeners: new Map(),
		llmCalls: [],
		commands: [],
	}
	const llm = {
		async *stream(options) {
			records.llmCalls.push(options)
			const text = replies(records.llmCalls.length - 1, options)
			if (text !== undefined && text !== null) yield { type: 'text-delta', index: 0, text }
			yield { type: 'finish', reason: { kind: 'stop' } }
		},
		listProviders() {
			return [
				{ id: 'prov-a', name: 'Provider A' },
				{ id: 'prov-b', name: 'Provider B' },
			]
		},
		async listModels(provider) {
			if (provider === 'prov-a') return [{ id: 'model-a', name: 'Model A' }]
			return []
		},
	}
	const tools = {
		register(definition) {
			records.tools.push(definition)
			return () => {}
		},
	}
	const systemPrompt = {
		section(section) {
			records.sections.push(section)
			return () => {}
		},
	}
	const commands = {
		register(definition) {
			records.commands.push(definition)
			return () => {}
		},
	}
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools,
		systemPrompt,
		effect(fn) {
			const dispose = fn()
			return typeof dispose === 'function' ? dispose : () => {}
		},
		on(event, listener) {
			const list = records.listeners.get(event) ?? []
			list.push(listener)
			records.listeners.set(event, list)
			return () => {}
		},
		inject(names, callback) {
			const available = names.every((name) => {
				if (name === 'commands') return commands !== undefined
				if (name === 'webServer') return webServer !== undefined
				return ctx.get(name) !== undefined
			})
			if (!available) return
			ctx.commands = commands
			ctx.webServer = webServer
			callback(ctx)
		},
		get(name) {
			if (name === 'llm') return llm
			if (name === 'commands') return commands
			if (name === 'agentDefaultModel') return { currentSelection: () => selection ?? { provider: 'default-prov', model: 'default-model' } }
			if (name === 'connection') return { requestRejection: () => undefined }
			return undefined
		},
	}
	return { ctx, records }
}

/** A fake live agent with a session route and derivation. */
function createFakeAgent({ id = 'session-1', provider = 'agent-prov', model = 'agent-model', origin } = {}) {
	return {
		id,
		options: { provider, model },
		steered: [],
		session: {
			header: { origin },
			requestHeader: () => ({ config: { provider, model } }),
			deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '我已完成任务。' }] }],
		},
		steer(message) {
			this.steered.push(message)
		},
	}
}

/** Dispatch one fake host event to the registered listeners. */
async function fire(records, event, ...args) {
	const listeners = records.listeners.get(event) ?? []
	let result = args
	for (const listener of listeners) result = [await listener(...result)]
	return result[0]
}

/** Run pre-step with one human message so the task anchor exists. */
async function admitHumanTask(records, agent, text = '把报告写到 out.md 并自检') {
	await fire(records, 'agent/pre-step', {
		agent,
		messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
		turn: 1,
		step: 1,
		signal: new AbortController().signal,
	}, async () => ({ kind: 'enter', messages: [] }))
}

const tempHome = mkdtempSync(join(tmpdir(), 'bicameral-test-'))
const previousHome = process.env.DSH_HOME

before(() => {
	process.env.DSH_HOME = tempHome
})

after(() => {
	if (previousHome === undefined) delete process.env.DSH_HOME
	else process.env.DSH_HOME = previousHome
	rmSync(tempHome, { recursive: true, force: true })
})

describe('mount', () => {
	test('registers the tool, the protocol section, and every host listener', () => {
		const { ctx, records } = createFakeCtx()
		apply(ctx, { enabled: true })
		assert.equal(records.tools.length, 1)
		assert.equal(records.tools[0].name, 'bicameral')
		assert.equal(records.sections.length, 1)
		assert.equal(records.sections[0].name, 'bicameral-mind')
		assert.equal(typeof records.sections[0].text, 'function')
		assert.ok(records.sections[0].text().includes('双声'))
		for (const event of ['agent/pre-step', 'tools/result', 'agent/turn-stopping', 'agent/disposed']) {
			assert.ok((records.listeners.get(event) ?? []).length >= 1, `missing listener: ${event}`)
		}
		assert.equal((records.listeners.get('tools/post-execute') ?? []).length, 0, 'auto review must stay out of the tool commit path')
		assert.equal(records.commands.length, 1)
	})

	test('a disabled plugin renders no protocol text', () => {
		const { ctx, records } = createFakeCtx()
		apply(ctx, { enabled: false })
		assert.equal(records.sections[0].text(), '')
	})
})

describe('two voices on two routes', () => {
	test('quick review uses the pinned examiner route, not the actor route', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"pass","summary":"与目标一致","issues":[],"questions":[]}',
		})
		const runtime = createRuntime(ctx, {
			voices: { examiner: { provider: 'examiner-prov', model: 'examiner-model' } },
		})
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		const tool = buildBicameralTool(runtime)
		const exec = { agent, signal: new AbortController().signal, arguments: {} }
		const value = await tool.execute({ stage: 'act', claim: '写入 out.md', evidence: '写入了三行' }, exec)
		assert.equal(value.verdict, 'pass')
		assert.equal(records.llmCalls.length, 1)
		assert.equal(records.llmCalls[0].provider, 'examiner-prov')
		assert.equal(records.llmCalls[0].model, 'examiner-model')
	})

	test('full depth exchanges three turns: examiner → actor rebuttal → examiner verdict', async () => {
		const replies = (index) => {
			if (index === 0) return '{"verdict":"revise","summary":"缺少验证","issues":[{"severity":"must","problem":"未验证输出","evidence":"只有写入结果","fix":"读取文件确认内容"}],"questions":[]}'
			if (index === 1) return '我接受第一条：会立刻读回文件；但第二条不成立，因为约束是只要三行。'
			return '{"verdict":"revise","summary":"答辩部分成立，仍需读回","issues":[{"severity":"should","problem":"读回验证未执行","evidence":"答辩承认将执行","fix":"执行读回"}],"questions":[]}'
		}
		const { ctx, records } = createFakeCtx({ replies })
		const runtime = createRuntime(ctx, {
			voices: { examiner: { provider: 'examiner-prov', model: 'strong-model' } },
		})
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		const tool = buildBicameralTool(runtime)
		const value = await tool.execute(
			{ stage: 'finish', claim: '任务完成', evidence: '已写入 out.md', depth: 'full' },
			{ agent, signal: new AbortController().signal },
		)
		assert.equal(records.llmCalls.length, 3)
		// 右脑两轮都在它自己的路由上
		assert.equal(records.llmCalls[0].provider, 'examiner-prov')
		assert.equal(records.llmCalls[2].provider, 'examiner-prov')
		// 左脑答辩走会话自己的路由
		assert.equal(records.llmCalls[1].provider, 'agent-prov')
		assert.equal(records.llmCalls[1].model, 'agent-model')
		assert.equal(value.rounds, 3)
		assert.equal(value.verdict, 'revise')
		assert.ok(value.transcript.reply.includes('我接受'))
	})

	test('an unreachable examiner route falls back to the session route', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"pass","summary":"ok","issues":[],"questions":[]}',
		})
		// llm.stream rejects for the pinned route only
		const originalStream = ctx.get('llm').stream
		ctx.get('llm').stream = function stream(options) {
			if (options.provider === 'broken-prov') {
				return (async function* () {
					yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no adapter', code: 'NO_ADAPTER' } } }
				})()
			}
			return originalStream.call(this, options)
		}
		const runtime = createRuntime(ctx, {
			voices: { examiner: { provider: 'broken-prov', model: 'broken-model', candidates: [] } },
		})
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		const tool = buildBicameralTool(runtime)
		const value = await tool.execute({ stage: 'act', claim: '继续', evidence: '' }, { agent, signal: new AbortController().signal })
		assert.equal(value.verdict, 'pass')
		assert.equal(records.llmCalls.at(-1).provider, 'agent-prov')
		// the successful route becomes sticky: the next review tries it first
		await tool.execute({ stage: 'act', claim: '继续', evidence: '' }, { agent, signal: new AbortController().signal })
		assert.equal(records.llmCalls.at(-1).provider, 'agent-prov')
		assert.equal(records.llmCalls.at(-1).model, 'agent-model')
	})

	test('a provider that ignores abort cannot hang a voice call', async () => {
		const { callVoice } = await import('../src/voice.js')
		const never = new Promise(() => {})
		const ctx = {
			get(name) {
				if (name === 'llm') {
					return {
						stream() {
							return (async function* produce() {
								await never
							})()
						},
					}
				}
				if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
				return undefined
			},
		}
		const started = Date.now()
		const result = await callVoice(ctx, {
			route: { provider: 'p', model: 'm' },
			system: 's',
			user: 'u',
			timeoutMs: 1000,
		})
		const elapsed = Date.now() - started
		assert.equal(result.ok, false)
		assert.ok(elapsed < 8000, `hard deadline must settle the call (took ${elapsed}ms)`)
		assert.match(result.error, /hard deadline|timed out/)
	})
})

describe('automatic interjection', () => {
	test('a revise verdict is admitted as a user message at the next step boundary', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"写错了文件","issues":[{"severity":"must","problem":"目标文件不符","evidence":"用户要求 out.md","fix":"改写到 out.md"}],"questions":[]}',
		})
		apply(ctx, { enabled: true, autoReview: { tools: ['write'], cooldownMs: 0 } })
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		// A consequential action completes: tools/result only marks a trigger.
		await fire(records, 'tools/result', { name: 'write', agent, arguments: { path: 'wrong.md' } }, { isError: false, content: [{ type: 'text', text: '已写入 wrong.md' }] })
		assert.equal(records.llmCalls.length, 0, 'no model call may happen inside tools/result')
		// The next step boundary admits the objection as its own user message.
		const decision = await fire(records, 'agent/pre-step', {
			agent,
			messages: [],
			turn: 1,
			step: 2,
			signal: new AbortController().signal,
		}, async () => ({ kind: 'enter', messages: [] }))
		assert.equal(decision.kind, 'enter')
		assert.equal(decision.messages.length, 1)
		const text = decision.messages[0].content[0].text
		assert.ok(text.startsWith('〔右脑·校正〕'))
		assert.ok(text.includes('不必盲从'))
		assert.equal(decision.messages[0].source.kind, 'plugin:bicameral-mind')
	})

	test('a pass verdict adds nothing', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"pass","summary":"一致","issues":[],"questions":[]}',
		})
		apply(ctx, { enabled: true, autoReview: { tools: ['write'], cooldownMs: 0 } })
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		await fire(records, 'tools/result', { name: 'write', agent, arguments: { path: 'out.md' } }, { isError: false, content: [{ type: 'text', text: 'ok' }] })
		const decision = await fire(records, 'agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
		assert.deepEqual(decision, { kind: 'enter', messages: [] })
		assert.equal(records.llmCalls.length, 1)
	})

	test('a tool outside the watch list never triggers a review', async () => {
		const { ctx, records } = createFakeCtx()
		apply(ctx, { enabled: true, autoReview: { tools: ['write'] } })
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		await fire(records, 'tools/result', { name: 'read', agent, arguments: { path: 'out.md' } }, { isError: false, content: [] })
		const decision = await fire(records, 'agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
		assert.deepEqual(decision, { kind: 'enter', messages: [] })
		assert.equal(records.llmCalls.length, 0)
	})

	test('the per-turn budget caps automatic reviews', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"偏题","issues":[{"severity":"should","problem":"p","evidence":"e","fix":"f"}],"questions":[]}',
		})
		apply(ctx, { enabled: true, autoReview: { tools: ['write'], cooldownMs: 0, maxPerTurn: 1 } })
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		const next = async () => ({ kind: 'enter', messages: [] })
		for (let step = 2; step <= 4; step += 1) {
			await fire(records, 'tools/result', { name: 'write', agent, arguments: { path: 'a.md' } }, { isError: false, content: [{ type: 'text', text: 'ok' }] })
			await fire(records, 'agent/pre-step', { agent, messages: [], turn: 1, step, signal: new AbortController().signal }, next)
		}
		assert.equal(records.llmCalls.length, 1)
	})

	test('a clearly read-only shell command is not reviewed', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"误判","issues":[{"severity":"must","problem":"p","evidence":"e","fix":"f"}],"questions":[]}',
		})
		apply(ctx, { enabled: true, autoReview: { tools: ['pwsh'], cooldownMs: 0 } })
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		await fire(
			records,
			'tools/result',
			{ name: 'pwsh', agent, arguments: { command: 'Get-Content README.md | Select-String example; Get-FileHash README.md' } },
			{ isError: false, content: [{ type: 'text', text: 'NONE' }] },
		)
		const decision = await fire(records, 'agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
		assert.deepEqual(decision, { kind: 'enter', messages: [] })
		assert.equal(records.llmCalls.length, 0, 'a read-only shell command must not spend an examiner call')
	})

	test('a mutating shell command is still reviewed', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"有副作用","issues":[{"severity":"must","problem":"删了文件","evidence":"Remove-Item","fix":"确认"}],"questions":[]}',
		})
		apply(ctx, { enabled: true, autoReview: { tools: ['pwsh'], cooldownMs: 0 } })
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		await fire(
			records,
			'tools/result',
			{ name: 'pwsh', agent, arguments: { command: 'Remove-Item -LiteralPath scratch/x.md -Force' } },
			{ isError: false, content: [{ type: 'text', text: 'deleted' }] },
		)
		const decision = await fire(records, 'agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
		assert.equal(records.llmCalls.length, 1)
		assert.equal(decision.messages.length, 1)
		assert.ok(decision.messages[0].content[0].text.startsWith('〔右脑·校正〕'))
	})
})

describe('convergence gate', () => {
	test('keeps the turn open while an examiner issue is unresolved', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"仍未验证","issues":[{"severity":"must","problem":"没有读回文件","evidence":"最终回答只说完成","fix":"读回 out.md"}],"questions":[]}',
		})
		const runtime = createRuntime(ctx, { autoReview: { finishGate: true, enabled: true } })
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		// seed one pending issue through a tool review
		runtime.store.recordReviewIssues(agent.id, {
			verdict: 'revise',
			stage: 'act',
			issues: [{ severity: 'must', problem: '未验证', evidence: 'e', fix: '读回文件' }],
			deliberate: true,
		})
		await runtime.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
		assert.equal(agent.steered.length, 1)
		assert.ok(agent.steered[0].content[0].text.startsWith('〔右脑·校正〕'))
		// the same turn is gated only once
		await runtime.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
		assert.equal(agent.steered.length, 1)
	})
})

describe('fail-safe parsing', () => {
	test('omitted evidence is only back-filled from recent actions in act stage', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"pass","summary":"ok","issues":[],"questions":[]}',
		})
		const runtime = createRuntime(ctx, {})
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		runtime.onToolResult({ name: 'write', arguments: { path: 'x.txt' }, agent }, { isError: false, content: [{ type: 'text', text: 'wrote x.txt' }] })
		const tool = buildBicameralTool(runtime)
		await tool.execute({ stage: 'checkpoint', claim: '结论已成立' }, { agent, signal: new AbortController().signal })
		const checkpointPrompt = records.llmCalls[0].messages[0].content[0].text
		assert.ok(!checkpointPrompt.includes('wrote x.txt'), 'checkpoint must not inherit an old action as evidence')
		await tool.execute({ stage: 'act', claim: '刚写完 x.txt' }, { agent, signal: new AbortController().signal })
		const actPrompt = records.llmCalls[1].messages[0].content[0].text
		assert.ok(actPrompt.includes('wrote x.txt'), 'act review should see the recent action')
	})

	test('a truncated but revision-marked JSON is never a pass', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"被截断","issues":[{"severity":"must","problem":"半截 issue","evidence":"ev',
		})
		const runtime = createRuntime(ctx, {})
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		const tool = buildBicameralTool(runtime)
		const value = await tool.execute({ stage: 'checkpoint', claim: '结论' }, { agent, signal: new AbortController().signal })
		assert.equal(value.verdict, 'revise')
	})

	test('unparseable prose that merely mentions pass is treated as revise', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '整体看起来可以通过，但存在误判为通过的风险，请再核对。',
		})
		const runtime = createRuntime(ctx, {})
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		const tool = buildBicameralTool(runtime)
		const value = await tool.execute({ stage: 'act', claim: '动作' }, { agent, signal: new AbortController().signal })
		assert.equal(value.verdict, 'revise')
		assert.ok(value.summary.includes('保守处理'))
	})

	test('a truncated pass fragment is still not trusted', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"pass","summary":"看起来没问题","issues":[{"severity":"must","problem":"被截断',
		})
		const runtime = createRuntime(ctx, {})
		const agent = createFakeAgent()
		await admitHumanTask(records, agent)
		const tool = buildBicameralTool(runtime)
		const value = await tool.execute({ stage: 'finish', claim: '完成' }, { agent, signal: new AbortController().signal })
		assert.equal(value.verdict, 'revise')
	})

	test('a later human message refines but never replaces the task anchor', async () => {
		const { ctx } = createFakeCtx()
		const runtime = createRuntime(ctx, {})
		const agent = createFakeAgent()
		await runtime.handlePreStep(
			{ agent, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '原始任务：只允许写 out.md' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
			async () => ({ kind: 'enter', messages: [] }),
		)
		await runtime.handlePreStep(
			{ agent, messages: [{ id: 'm2', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }], turn: 2, step: 1, signal: new AbortController().signal },
			async () => ({ kind: 'enter', messages: [] }),
		)
		const state = runtime.store.peek(agent.id)
		assert.equal(state.task, '原始任务：只允许写 out.md')
		assert.equal(state.latestHuman, '继续')
	})

	test('outstanding issues merge instead of being wiped by an unrelated act pass', async () => {
		const { ctx } = createFakeCtx()
		const runtime = createRuntime(ctx, {})
		const agent = createFakeAgent()
		runtime.store.recordReviewIssues(agent.id, {
			verdict: 'revise',
			stage: 'act',
			issues: [{ severity: 'must', problem: '输出未验证', evidence: 'e', fix: '读回' }],
			deliberate: false,
		})
		assert.equal(runtime.store.peek(agent.id).pendingIssues.length, 1)
		// an incidental act pass must not clear it
		runtime.store.recordReviewIssues(agent.id, { verdict: 'pass', stage: 'act', issues: [], deliberate: false })
		assert.equal(runtime.store.peek(agent.id).pendingIssues.length, 1)
		// a deliberate checkpoint pass does converge
		runtime.store.recordReviewIssues(agent.id, { verdict: 'pass', stage: 'checkpoint', issues: [], deliberate: true })
		assert.equal(runtime.store.peek(agent.id).pendingIssues.length, 0)
	})

	test('render never shows the raw JSON critique in quick mode', () => {
		const { ctx } = createFakeCtx()
		const runtime = createRuntime(ctx, {})
		const tool = buildBicameralTool(runtime)
		const value = {
			verdict: 'revise',
			summary: '缺验证',
			issues: [{ severity: 'must', problem: '未读回', evidence: '只有写入', fix: '读回' }],
			questions: [],
			rounds: 1,
			depth: 'quick',
			stage: 'act',
			provider: 'p',
			model: 'm',
			degraded: false,
			transcript: { advocate: '主张', critique: '{"verdict":"revise"}' },
		}
		const rendered = tool.output.render({}, value)[0].text
		assert.ok(!rendered.includes('"verdict"'))
		assert.ok(rendered.includes('右脑模型：p/m'))
		const fullRendered = tool.output.render({}, { ...value, depth: 'full' })[0].text
		assert.ok(fullRendered.includes('右脑质疑'))
		const unavailable = tool.output.render({}, { ...value, verdict: 'unavailable', summary: '路由挂了' })[0].text
		assert.ok(unavailable.includes('不可用'))
	})
})

describe('diagnostics route', () => {
	/** Fake response capturing the JSON body. */
	function createRes() {
		const res = {
			statusCode: 0,
			headers: {},
			body: '',
			setHeader(name, value) {
				this.headers[name] = value
			},
			end(chunk) {
				if (typeof chunk === 'string') this.body = chunk
			},
		}
		return res
	}

	test('serves the snapshot and refuses a cross-site request', async () => {
		const routes = []
		const webServer = {
			register(route) {
				routes.push(route)
				return () => {}
			},
		}
		const { ctx } = createFakeCtx({ webServer })
		apply(ctx, { enabled: true })
		assert.equal(routes.length, 6)
		const stateRoute = routes.find((route) => route.path === '/bicameral-mind/state')
		const toggleRoute = routes.find((route) => route.path === '/bicameral-mind/toggle')

		const sameOrigin = { host: '127.0.0.1:46843', 'sec-fetch-site': 'same-origin' }
		const res = createRes()
		await stateRoute.handler({ method: 'GET', url: '/bicameral-mind/state?sessionId=session-1', headers: sameOrigin }, res)
		assert.equal(res.statusCode, 200)
		const payload = JSON.parse(res.body)
		assert.equal(payload.ok, true)
		assert.ok(payload.voices.actor.routes.length >= 1)
		assert.ok(Array.isArray(payload.sessions))

		const missing = createRes()
		await stateRoute.handler({ method: 'GET', url: '/bicameral-mind/state', headers: sameOrigin }, missing)
		assert.equal(missing.statusCode, 400)

		const refused = createRes()
		await stateRoute.handler(
			{ method: 'GET', url: '/bicameral-mind/state?sessionId=session-1', headers: { host: '127.0.0.1:46843', 'sec-fetch-site': 'cross-site' } },
			refused,
		)
		assert.equal(refused.statusCode, 403)

		const toggled = createRes()
		const request = {
			method: 'POST',
			url: '/bicameral-mind/toggle',
			headers: sameOrigin,
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(JSON.stringify({ enabled: false }))
			},
		}
		await toggleRoute.handler(request, toggled)
		assert.equal(toggled.statusCode, 200)
		assert.equal(JSON.parse(toggled.body).enabled, false)
	})

	test('settings config, models and probe routes', async () => {
		const routes = []
		const webServer = {
			register(route) {
				routes.push(route)
				return () => {}
			},
		}
		const { ctx } = createFakeCtx({ webServer })
		apply(ctx, { enabled: true })
		const configRoute = routes.find((route) => route.path === '/bicameral-mind/config')
		const modelsRoute = routes.find((route) => route.path === '/bicameral-mind/models')
		const probeRoute = routes.find((route) => route.path === '/bicameral-mind/probe')
		const levelRoute = routes.find((route) => route.path === '/bicameral-mind/level')
		const sameOrigin = { host: '127.0.0.1:46843', 'sec-fetch-site': 'same-origin' }

		const got = createRes()
		await configRoute.handler({ method: 'GET', url: '/bicameral-mind/config', headers: sameOrigin }, got)
		assert.equal(got.statusCode, 200)
		const view = JSON.parse(got.body)
		assert.equal(view.ok, true)
		assert.ok(view.settings.voices.examiner)
		assert.ok(Array.isArray(view.routes.examiner))

		const posted = createRes()
		const post = {
			method: 'POST',
			url: '/bicameral-mind/config',
			headers: sameOrigin,
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(
					JSON.stringify({
						patch: {
							voices: {
								examiner: {
									provider: 'test-provider',
									model: 'test-model',
									candidates: [{ provider: 'test-fallback', model: 'fallback-model' }],
								},
							},
							autoReview: { cooldownMs: 5000 },
						},
					}),
				)
			},
		}
		await configRoute.handler(post, posted)
		assert.equal(posted.statusCode, 200)
		const updated = JSON.parse(posted.body)
		assert.equal(updated.settings.voices.examiner.provider, 'test-provider')
		assert.equal(updated.settings.voices.examiner.model, 'test-model')
		assert.equal(updated.settings.autoReview.cooldownMs, 5000)

		const invalid = createRes()
		const badPatch = {
			method: 'POST',
			url: '/bicameral-mind/config',
			headers: sameOrigin,
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(JSON.stringify({ patch: { voices: { examiner: { provider: 'only-provider' } } } }))
			},
		}
		await configRoute.handler(badPatch, invalid)
		assert.equal(invalid.statusCode, 400)
		assert.ok(JSON.parse(invalid.body).message.includes('provider'))

		const models = createRes()
		await modelsRoute.handler({ method: 'GET', url: '/bicameral-mind/models', headers: sameOrigin }, models)
		assert.equal(models.statusCode, 200)
		const catalog = JSON.parse(models.body)
		assert.ok(catalog.providers.some((provider) => provider.provider === 'prov-a' && provider.models.some((model) => model.id === 'model-a')))

		const probed = createRes()
		const probeRequest = {
			method: 'POST',
			url: '/bicameral-mind/probe',
			headers: sameOrigin,
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(JSON.stringify({ provider: 'prov-a', model: 'model-a' }))
			},
		}
		await probeRoute.handler(probeRequest, probed)
		assert.equal(probed.statusCode, 200)
		assert.equal(JSON.parse(probed.body).ok, true)

		const leveled = createRes()
		const levelRequest = {
			method: 'POST',
			url: '/bicameral-mind/level',
			headers: sameOrigin,
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(JSON.stringify({ level: 'strict' }))
			},
		}
		await levelRoute.handler(levelRequest, leveled)
		assert.equal(leveled.statusCode, 200)
		const levelView = JSON.parse(leveled.body)
		assert.equal(levelView.level, 'strict')
		assert.deepEqual(levelView.levels.map((level) => level.id), ['off', 'advisory', 'balanced', 'strict', 'paranoid'])

		const badLevel = createRes()
		const badLevelRequest = {
			method: 'POST',
			url: '/bicameral-mind/level',
			headers: sameOrigin,
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(JSON.stringify({ level: 'nope' }))
			},
		}
		await levelRoute.handler(badLevelRequest, badLevel)
		assert.equal(badLevel.statusCode, 400)

		// reset persisted settings so later tests see the defaults again
		const reset = createRes()
		const resetRequest = {
			method: 'POST',
			url: '/bicameral-mind/config',
			headers: sameOrigin,
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(
					JSON.stringify({
						patch: {
							voices: { examiner: { provider: '', model: '', candidates: [] } },
							autoReview: { cooldownMs: 15000 },
						},
					}),
				)
			},
		}
		await configRoute.handler(resetRequest, reset)
		assert.equal(reset.statusCode, 200)

		// leave the shared settings file on the default level for later tests
		const rebalanced = createRes()
		const rebalancedRequest = {
			method: 'POST',
			url: '/bicameral-mind/level',
			headers: sameOrigin,
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(JSON.stringify({ level: 'balanced' }))
			},
		}
		await levelRoute.handler(rebalancedRequest, rebalanced)
		assert.equal(rebalanced.statusCode, 200)
	})
})

describe('commands', () => {
	test('status reports both voices; voice pins persist to the settings file', async () => {
		const { ctx } = createFakeCtx()
		const runtime = createRuntime(ctx, {})
		const command = buildCommand(runtime)
		const agent = createFakeAgent()
		const status = await command.handler({ agent, rawInput: 'status' })
		assert.equal(status.kind, 'success')
		assert.ok(status.text.includes('左脑模型'))
		assert.ok(status.text.includes('右脑模型'))

		const pinned = await command.handler({ agent, rawInput: 'voice examiner example-provider example/model' })
		assert.equal(pinned.kind, 'success')
		assert.equal(runtime.current().voices.examiner.provider, 'example-provider')
		assert.equal(runtime.current().voices.examiner.model, 'example/model')
		// 左脑 still follows the session route
		assert.deepEqual(runtime.routesFor(agent, 'actor')[0], { provider: 'agent-prov', model: 'agent-model' })

		const reset = await command.handler({ agent, rawInput: 'voice examiner reset' })
		assert.equal(reset.kind, 'success')
		assert.equal(runtime.current().voices.examiner.provider, '')
	})

	test('unknown subcommands report usage instead of throwing', async () => {
		const { ctx } = createFakeCtx()
		const runtime = createRuntime(ctx, {})
		const command = buildCommand(runtime)
		const answer = await command.handler({ agent: createFakeAgent(), rawInput: 'nope' })
		assert.equal(answer.kind, 'error')
		assert.ok(answer.text.includes('/bicameral status'))
	})
})

describe('intervention levels', () => {
	test('each preset expands into its differentiated knobs', () => {
		const { ctx } = createFakeCtx()
		const runtime = createRuntime(ctx, {})

		assert.ok(runtime.applyLevel('balanced').ok)
		assert.equal(runtime.configView().level, 'balanced')
		let cfg = runtime.current()
		assert.equal(cfg.enabled, true)
		assert.equal(cfg.autoReview.enabled, true)
		assert.equal(cfg.autoReview.tools.includes('*'), false)
		assert.equal(cfg.autoReview.finishAlways, false)

		assert.ok(runtime.applyLevel('strict').ok)
		assert.equal(runtime.configView().level, 'strict')
		cfg = runtime.current()
		assert.equal(cfg.autoReview.tools.includes('*'), true)
		assert.equal(cfg.autoReview.finishAlways, true)
		assert.equal(runtime.editableSettings().autoReview.finishAlways, true)
		assert.equal(cfg.autoReview.cooldownMs, 8000)
		assert.equal(cfg.autoReview.maxPerTurn, 12)
		assert.equal(cfg.maxIssues, 4)
		assert.ok(cfg.tool.fullStages.includes('checkpoint'))

		assert.ok(runtime.applyLevel('paranoid').ok)
		assert.equal(runtime.configView().level, 'paranoid')
		cfg = runtime.current()
		assert.equal(cfg.autoReview.shellReadGuard, false)
		assert.equal(cfg.autoReview.cooldownMs, 0)
		assert.equal(cfg.autoReview.maxPerTurn, 50)
		assert.equal(cfg.tool.defaultDepth, 'full')
		assert.equal(cfg.maxIssues, 5)

		assert.ok(runtime.applyLevel('advisory').ok)
		cfg = runtime.current()
		assert.equal(cfg.enabled, true)
		assert.equal(cfg.autoReview.enabled, false)
		assert.equal(cfg.autoReview.finishGate, false)

		assert.ok(runtime.applyLevel('off').ok)
		assert.equal(runtime.current().enabled, false)
		assert.equal(runtime.configView().level, 'off')

		assert.equal(runtime.applyLevel('nope').ok, false)
		runtime.applyLevel('balanced')
	})

	test('hand-tuned settings fall back to custom', () => {
		const { ctx } = createFakeCtx()
		const runtime = createRuntime(ctx, {})
		runtime.applyLevel('strict')
		assert.equal(runtime.configView().level, 'strict')
		assert.ok(runtime.applyEditablePatch({ autoReview: { cooldownMs: 12345 } }).ok)
		assert.equal(runtime.configView().level, 'custom')
		assert.ok(runtime.applyEditablePatch({ autoReview: { finishAlways: false } }).ok)
		assert.equal(runtime.current().autoReview.finishAlways, false)
		assert.equal(runtime.configView().level, 'custom')
		runtime.applyLevel('balanced')
	})

	test('strict wildcard reviews tools outside the balanced list', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"偏题","issues":[{"severity":"must","problem":"p","evidence":"e","fix":"f"}],"questions":[]}',
		})
		const runtime = createRuntime(ctx, {})
		runtime.applyLevel('strict')
		const agent = createFakeAgent()
		const next = async () => ({ kind: 'enter', messages: [] })
		await runtime.handlePreStep(
			{ agent, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '任务' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
			next,
		)
		runtime.onToolResult({ name: 'read', agent, arguments: { path: 'x' } }, { isError: false, content: [{ type: 'text', text: 'ok' }] })
		const decision = await runtime.handlePreStep({ agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, next)
		assert.equal(records.llmCalls.length, 1)
		assert.equal(decision.messages.length, 1)
		assert.ok(decision.messages[0].content[0].text.startsWith('〔右脑·校正〕'))
		runtime.applyLevel('balanced')
	})

	test('balanced does not review tools outside its list', async () => {
		const { ctx, records } = createFakeCtx({ replies: () => '{"verdict":"pass","summary":"ok","issues":[],"questions":[]}' })
		const runtime = createRuntime(ctx, {})
		runtime.applyLevel('balanced')
		const agent = createFakeAgent()
		const next = async () => ({ kind: 'enter', messages: [] })
		await runtime.handlePreStep(
			{ agent, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '任务' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
			next,
		)
		runtime.onToolResult({ name: 'read', agent, arguments: { path: 'x' } }, { isError: false, content: [{ type: 'text', text: 'ok' }] })
		await runtime.handlePreStep({ agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, next)
		assert.equal(records.llmCalls.length, 0)
	})

	test('paranoid reviews read-only shell commands', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"复核","issues":[{"severity":"should","problem":"p","evidence":"e","fix":"f"}],"questions":[]}',
		})
		const runtime = createRuntime(ctx, {})
		runtime.applyLevel('paranoid')
		const agent = createFakeAgent()
		const next = async () => ({ kind: 'enter', messages: [] })
		await runtime.handlePreStep(
			{ agent, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '任务' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
			next,
		)
		runtime.onToolResult({ name: 'pwsh', agent, arguments: { command: 'Get-Content README.md' } }, { isError: false, content: [{ type: 'text', text: 'NONE' }] })
		await runtime.handlePreStep({ agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, next)
		// paranoid reviews at full depth: critique + advocate reply + final verdict
		assert.equal(records.llmCalls.length, 3)
		runtime.applyLevel('balanced')
	})

	test('strict finishAlways reviews the final answer without pending issues', async () => {
		const { ctx, records } = createFakeCtx({
			replies: () => '{"verdict":"revise","summary":"还有未验证的断言","issues":[{"severity":"must","problem":"未验证","evidence":"回答","fix":"补验证"}],"questions":[]}',
		})
		const runtime = createRuntime(ctx, {})
		runtime.applyLevel('strict')
		const agent = createFakeAgent()
		const next = async () => ({ kind: 'enter', messages: [] })
		await runtime.handlePreStep(
			{ agent, messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '任务' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
			next,
		)
		await runtime.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
		assert.equal(records.llmCalls.length, 3)
		assert.equal(agent.steered.length, 1)
		await runtime.onTurnStopping({ agent, turn: 1, signal: new AbortController().signal })
		assert.equal(agent.steered.length, 1)
		runtime.applyLevel('balanced')
	})

	test('the level command lists and switches presets', async () => {
		const { ctx } = createFakeCtx()
		const runtime = createRuntime(ctx, {})
		runtime.applyLevel('balanced')
		const command = buildCommand(runtime)
		const agent = createFakeAgent()
		const listed = await command.handler({ agent, rawInput: 'level' })
		assert.equal(listed.kind, 'success')
		assert.ok(listed.text.includes('balanced'))
		assert.ok(listed.text.includes('strict'))
		const switched = await command.handler({ agent, rawInput: 'level paranoid' })
		assert.equal(switched.kind, 'success')
		assert.equal(runtime.configView().level, 'paranoid')
		const bad = await command.handler({ agent, rawInput: 'level nope' })
		assert.equal(bad.kind, 'error')
		runtime.applyLevel('balanced')
	})
})

describe('text consistency', () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..')
	const shipped = [
		'index.js',
		'client.js',
		'README.md',
		'CHANGELOG.md',
		'icon.svg',
		'package.json',
		'cordis.patch.yml',
		'locale/zh.json',
		'locale/en.json',
		'src/command.js',
		'src/config.js',
		'src/examiner.js',
		'src/prompt.js',
		'src/runtime.js',
		'src/state.js',
		'src/tool.js',
		'src/util.js',
		'src/voice.js',
		'src/webui.js',
	]

	test('legacy voice names never appear in shipped text or artwork', () => {
		for (const file of shipped) {
			const text = readFileSync(join(root, file), 'utf8')
			assert.ok(!/甲|乙/.test(text), `${file} still contains the legacy 甲/乙 characters`)
		}
	})

	test('model-facing and user-facing layers both use 左脑/右脑', () => {
		for (const file of ['src/prompt.js', 'src/tool.js', 'client.js', 'README.md']) {
			const text = readFileSync(join(root, file), 'utf8')
			assert.ok(text.includes('左脑'), `${file} must mention 左脑`)
			assert.ok(text.includes('右脑'), `${file} must mention 右脑`)
		}
	})
})
