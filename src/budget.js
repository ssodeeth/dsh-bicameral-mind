/**
 * Cost guardrails: hard per-turn limits on examiner spending.
 *
 * The intervention level decides *when* the right brain speaks; this module
 * decides *how much* it may spend in one turn. Limits are counted in model
 * calls (a full debate costs three), full debates, and a conservative token
 * estimate based on each call's maxTokens. Once a limit is hit, the rest of the
 * turn degrades to "no more reviews" instead of silently overspending.
 *
 * @module dsh-bicameral-mind/budget
 */

/** Preset tiers shown in the settings page and the command. */
export const BUDGET_PRESETS = [
	{
		id: 'relaxed',
		title: '宽松',
		description: '每轮最多 30 次调用、8 次完整辩论、约 60k tokens；适合长任务。',
		values: { maxCallsPerTurn: 30, maxFullDebatesPerTurn: 8, maxTokensPerTurn: 60000 },
	},
	{
		id: 'standard',
		title: '标准',
		description: '每轮最多 12 次调用、3 次完整辩论、约 24k tokens（默认）。',
		values: { maxCallsPerTurn: 12, maxFullDebatesPerTurn: 3, maxTokensPerTurn: 24000 },
	},
	{
		id: 'frugal',
		title: '节约',
		description: '每轮最多 6 次调用、1 次完整辩论、约 12k tokens；成本优先。',
		values: { maxCallsPerTurn: 6, maxFullDebatesPerTurn: 1, maxTokensPerTurn: 12000 },
	},
]

/** The settings-file patch for one budget preset. */
export function budgetPresetPatch(id) {
	const preset = BUDGET_PRESETS.find((entry) => entry.id === id)
	if (preset === undefined) return undefined
	return { budget: { enabled: true, ...preset.values } }
}

/** Which preset the effective budget matches, or `custom`. */
export function detectBudgetTier(budget) {
	if (budget === undefined || budget === null || budget.enabled === false) return budget?.enabled === false ? 'off' : 'custom'
	for (const preset of BUDGET_PRESETS) {
		if (
			budget.maxCallsPerTurn === preset.values.maxCallsPerTurn &&
			budget.maxFullDebatesPerTurn === preset.values.maxFullDebatesPerTurn &&
			budget.maxTokensPerTurn === preset.values.maxTokensPerTurn
		) {
			return preset.id
		}
	}
	return 'custom'
}
