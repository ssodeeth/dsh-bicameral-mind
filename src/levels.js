/**
 * Intervention levels for Bicameral Mind.
 *
 * One level expands into the concrete knobs the runtime already understands
 * (auto-review scope, cooldowns, finish mode, debate depth). Keeping the presets
 * here means the settings page, the `/bicameral level` command, and detection of
 * a hand-tuned configuration all agree on the same values.
 *
 * @module dsh-bicameral-mind/levels
 */

/** Wildcard used by `autoReview.tools` to mean "every tool". */
export const REVIEW_ALL = '*'

/** Tools reviewed by the balanced default. */
const DEFAULT_TOOLS = ['write', 'edit', 'pwsh', 'bash', 'run_code', 'delete_file', 'move_file']

/** Stage sets. */
const FULL_PLAN_FINISH = ['plan', 'finish']
const FULL_PLAN_CHECK_FINISH = ['plan', 'checkpoint', 'finish']
const FULL_ALL = ['plan', 'act', 'checkpoint', 'finish']

/** Level metadata shown in the settings page and the command. */
export const LEVELS = [
	{
		id: 'off',
		title: '关闭',
		description: '完全不介入：协议与工具均不可用，不做任何自动复审。',
	},
	{
		id: 'advisory',
		title: '提示',
		description: '只在左脑显式调用 bicameral 时介入；不主动插话、不做收尾检查。',
	},
	{
		id: 'balanced',
		title: '标准',
		description: '有后果的写入 / 执行后主动复核；未决问题未收敛时收尾闸门介入。',
	},
	{
		id: 'strict',
		title: '严格',
		description: '所有工具动作都复核（明显只读的 shell 命令除外）；每轮收尾都会再审一次；计划 / 阶段 / 收尾用完整审议。',
	},
	{
		id: 'paranoid',
		title: '偏执',
		description: '连只读命令也复核；每次审议默认完整对话；冷却为 0、每轮预算最高，成本与延迟最高。',
	},
]

/** Look up one level definition. */
export function levelById(id) {
	return LEVELS.find((level) => level.id === id)
}

/**
 * The settings-file patch for one level.
 *
 * The patch is intentionally complete for every knob a level controls, so
 * applying a level fully overrides earlier hand-tuning.
 */
export function presetPatch(id) {
	const baseAuto = {
		tools: DEFAULT_TOOLS,
		cooldownMs: 15000,
		maxPerTurn: 6,
		timeoutMs: 20000,
		maxTokens: 700,
		includeErrors: true,
		finishGate: true,
		finishAlways: false,
		shellReadGuard: true,
	}
	const baseTool = { defaultDepth: 'quick', fullStages: FULL_PLAN_FINISH }
	switch (id) {
		case 'off':
			return {
				intervention: 'off',
				enabled: false,
				maxIssues: 3,
				autoReview: { ...baseAuto, enabled: false, finishGate: false, finishAlways: false },
				tool: { ...baseTool },
			}
		case 'advisory':
			return {
				intervention: 'advisory',
				enabled: true,
				maxIssues: 3,
				autoReview: { ...baseAuto, enabled: false, finishGate: false, finishAlways: false },
				tool: { ...baseTool },
			}
		case 'balanced':
			return {
				intervention: 'balanced',
				enabled: true,
				maxIssues: 3,
				autoReview: { ...baseAuto, enabled: true },
				tool: { ...baseTool },
			}
		case 'strict':
			return {
				intervention: 'strict',
				enabled: true,
				maxIssues: 4,
				autoReview: {
					...baseAuto,
					enabled: true,
					tools: [REVIEW_ALL],
					cooldownMs: 8000,
					maxPerTurn: 12,
					timeoutMs: 25000,
					maxTokens: 900,
					finishAlways: true,
				},
				tool: { defaultDepth: 'quick', fullStages: FULL_PLAN_CHECK_FINISH },
			}
		case 'paranoid':
			return {
				intervention: 'paranoid',
				enabled: true,
				maxIssues: 5,
				autoReview: {
					...baseAuto,
					enabled: true,
					tools: [REVIEW_ALL],
					cooldownMs: 0,
					maxPerTurn: 50,
					timeoutMs: 30000,
					maxTokens: 1100,
					finishAlways: true,
					shellReadGuard: false,
				},
				tool: { defaultDepth: 'full', fullStages: FULL_ALL },
			}
		default:
			return undefined
	}
}

/** Compare one list ignoring order. */
function sameList(a, b) {
	const left = Array.isArray(a) ? [...a].sort() : []
	const right = Array.isArray(b) ? [...b].sort() : []
	return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Detect which level the effective settings represent.
 *
 * @returns a level id, or `custom` when the user hand-tuned a knob.
 */
export function detectLevel(settings) {
	if (settings === undefined || settings === null) return 'custom'
	for (const level of LEVELS) {
		const preset = presetPatch(level.id)
		if (preset === undefined) continue
		const auto = settings.autoReview ?? {}
		const presetAuto = preset.autoReview
		const tool = settings.tool ?? {}
		const presetTool = preset.tool
		const matches =
			settings.enabled === preset.enabled &&
			settings.maxIssues === preset.maxIssues &&
			auto.enabled === presetAuto.enabled &&
			auto.cooldownMs === presetAuto.cooldownMs &&
			auto.maxPerTurn === presetAuto.maxPerTurn &&
			auto.timeoutMs === presetAuto.timeoutMs &&
			auto.maxTokens === presetAuto.maxTokens &&
			auto.includeErrors === presetAuto.includeErrors &&
			auto.finishGate === presetAuto.finishGate &&
			auto.finishAlways === presetAuto.finishAlways &&
			auto.shellReadGuard === presetAuto.shellReadGuard &&
			sameList(auto.tools, presetAuto.tools) &&
			tool.defaultDepth === presetTool.defaultDepth &&
			sameList(tool.fullStages, presetTool.fullStages)
		if (matches) return level.id
	}
	return 'custom'
}
