/**
 * The `bicameral` tool: the actor's explicit request for an independent review.
 *
 * The definition is a plain object (the registry accepts raw definitions); the
 * model-facing schema, the canonical JSON value, and the rendered Markdown card
 * are all declared here so the tool surface stays in one place.
 *
 * @module dsh-bicameral-mind/tool
 */
import { formatToolResult } from './examiner.js'
import { normalizeStage, TOOL_NAME } from './runtime.js'
import { str } from './util.js'

const DESCRIPTION = [
	'对当前主张或刚完成的一步做一次独立的双声审议。右脑由另一个独立模型生成（可与主模型不同），',
	'它只看你提供的主张与证据，会指出：目标偏离、证据不足、未经验证的断言、不可逆风险、与先前步骤矛盾、完成度缺口。',
	'何时调用：计划成形前（plan）、有后果的动作前后（act）、阶段性结论前（checkpoint）、宣布完成前（finish），或你对结论没有把握时。',
	'返回：verdict（pass/revise/block/unavailable）、逐条问题（含证据与最小修正动作）；depth=full 时还返回左脑答辩与右脑终裁。',
	'它不是工作替代品：只用于纠偏，不用于代替执行或验证。',
].join('\n')

const PARAMETERS = {
	type: 'object',
	properties: {
		stage: {
			type: 'string',
			enum: ['plan', 'act', 'checkpoint', 'finish'],
			description: '审议时刻：plan=计划成形前；act=刚做或将做有后果的动作；checkpoint=阶段性结论前；finish=宣布完成前。',
		},
		claim: {
			type: 'string',
			description: '左脑此刻的主张：你要做什么、刚做了什么、为何这样做。要具体，不要写空话。',
		},
		evidence: {
			type: 'string',
			description: '供右脑独立判断的证据摘要：关键工具结果、文件路径与片段、命令输出、用户原话。省略时系统只提供最近的工具动作摘要，右脑判断会变弱。',
		},
		task: {
			type: 'string',
			description: '任务目标的一句话复述。省略时使用本会话捕获到的最新用户请求。',
		},
		depth: {
			type: 'string',
			enum: ['quick', 'full'],
			description: 'quick=单轮质疑（默认用于 act/checkpoint）；full=质疑→左脑答辩→右脑终裁（默认用于 plan/finish，成本更高，能发现方向性错误）。',
		},
		rebuttal: {
			type: 'string',
			description: '若你在回应上一轮右脑的异议，把答辩要点写在这里（认同哪些、反驳哪些、依据是什么）。',
		},
	},
	required: ['stage', 'claim'],
	additionalProperties: false,
}

const OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['pass', 'revise', 'block', 'unavailable'] },
		summary: { type: 'string' },
		issues: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					severity: { type: 'string' },
					problem: { type: 'string' },
					evidence: { type: 'string' },
					fix: { type: 'string' },
				},
				required: ['severity', 'problem', 'evidence', 'fix'],
			},
		},
		questions: { type: 'array', items: { type: 'string' } },
		rounds: { type: 'integer' },
		depth: { type: 'string' },
		stage: { type: 'string' },
		provider: { type: 'string' },
		model: { type: 'string' },
		degraded: { type: 'boolean' },
		degradedReason: { type: 'string' },
		attempts: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					provider: { type: 'string' },
					model: { type: 'string' },
					error: { type: 'string' },
				},
				required: ['provider', 'model', 'error'],
			},
		},
		transcript: {
			type: 'object',
			properties: {
				advocate: { type: 'string' },
				critique: { type: 'string' },
				reply: { type: 'string' },
				final: { type: 'string' },
			},
		},
	},
	required: ['verdict', 'summary', 'issues', 'questions', 'rounds', 'depth', 'stage', 'provider', 'model', 'degraded', 'transcript'],
}

/** Render the canonical value as a compact Markdown card for the model. */
function render(_args, value) {
	if (value?.verdict === 'unavailable') {
		return [{ type: 'text', text: `**〔右脑·不可用〕**\n${value.summary ?? '右脑暂时无法生成裁决。'}` }]
	}
	const text = formatToolResult({
		stage: value?.stage,
		verdict: value?.verdict,
		summary: value?.summary,
		issues: value?.issues,
		questions: value?.questions,
		// quick 模式的 critique 就是原始 JSON，解析结果已经展示过，不再重复。
		transcript: value?.depth === 'full' ? value?.transcript : undefined,
		degraded: value?.degraded === true,
		degradedReason: value?.degradedReason,
	})
	const meta = typeof value?.provider === 'string' && value.provider.length > 0 && typeof value?.model === 'string' && value.model.length > 0
		? `\n\n_右脑模型：${value.provider}/${value.model} · ${value.rounds} 轮_`
		: ''
	const failed = Array.isArray(value?.attempts) ? value.attempts : []
	const failNote = failed.length === 0
		? ''
		: `\n_候选未使用：${failed.slice(0, 3).map((attempt) => `${attempt.provider}/${attempt.model}（${String(attempt.error ?? '').slice(0, 80)}）`).join('；')}_`
	return [{ type: 'text', text: `${text}${meta}${failNote}` }]
}

/** Build the tool definition bound to one runtime instance. */
export function buildBicameralTool(runtime) {
	return {
		name: TOOL_NAME,
		description: DESCRIPTION,
		parameters: PARAMETERS,
		output: { schema: OUTPUT_SCHEMA, render },
		async execute(args, exec) {
			const input = args !== null && typeof args === 'object' ? args : {}
			const stage = normalizeStage(input.stage)
			const result = await runtime.review({
				agent: exec?.agent,
				stage,
				claim: str(input.claim),
				evidence: str(input.evidence),
				task: str(input.task),
				depth: input.depth === 'full' ? 'full' : input.depth === 'quick' ? 'quick' : undefined,
				rebuttal: str(input.rebuttal),
				signal: exec?.signal,
				origin: 'tool',
				toolName: TOOL_NAME,
			})
			return {
				verdict: result.verdict,
				summary: result.summary,
				issues: Array.isArray(result.issues) ? result.issues : [],
				questions: Array.isArray(result.questions) ? result.questions : [],
				rounds: result.rounds,
				depth: result.depth,
				stage: result.stage ?? stage,
				provider: result.provider ?? '',
				model: result.model ?? '',
				degraded: result.degraded === true,
				degradedReason: result.degradedReason ?? '',
				attempts: Array.isArray(result.attempts) ? result.attempts : [],
				transcript: result.transcript ?? { advocate: '', critique: '' },
			}
		},
		presentCall() {
			return { card: 'generic', title: '双声审议 · bicameral' }
		},
	}
}
