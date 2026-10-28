/**
 * Configuration and plugin-owned runtime settings for Bicameral Mind.
 *
 * Two layers exist on purpose:
 *  - the composition row's `config` (cordis.patch.yml) owns deployment defaults;
 *  - a small JSON file under the Harness home owns the user's runtime choices
 *    made through `/bicameral`, so changing a voice model never requires
 *    hand-editing the profile patch.
 *
 * The two voices are independently routed on purpose: 左脑 (the actor) may stay
 * on the session's own model, while 右脑 (the examiner) can be pinned to a
 * different, stronger model. That is what makes the second voice genuinely
 * independent rather than an echo of the first.
 *
 * @module dsh-bicameral-mind/config
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { clampInt, clampNumber, str, strList } from './util.js'

/** Tools whose results are worth an automatic examiner pass. */
export const DEFAULT_REVIEW_TOOLS = ['write', 'edit', 'pwsh', 'bash', 'run_code', 'delete_file', 'move_file']

/** Stages that default to the expensive two-round review. */
export const DEFAULT_FULL_STAGES = ['plan', 'finish']

/** One-line statement of the plugin's purpose, reused by the tool and README. */
export const PLUGIN_TITLE = '二分心智 · Bicameral Mind'

/**
 * Resolve the Harness home the way the Host does.
 *
 * The Host may provide an explicit path (`dshHomePath`) even when `$DSH_HOME`
 * is not set, so prefer the service, then the environment, then `~/.dsh`.
 */
export function resolveDshHome(ctx) {
	try {
		const provided = ctx?.get?.('dshHomePath')
		if (typeof provided === 'function') {
			const value = provided()
			if (typeof value === 'string' && value.trim().length > 0) return value.trim()
		}
	} catch {
		/* fall through */
	}
	const fromEnv = process.env.DSH_HOME
	if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
	return join(homedir(), '.dsh')
}

/** Path of the user-owned runtime settings file. */
export function settingsPath(home) {
	return join(home, 'storages', 'bicameral-mind', 'settings.json')
}

/** Read the runtime settings file; malformed or missing files read as `{}`. */
export function readSettings(home, logger) {
	const file = settingsPath(home)
	if (!existsSync(file)) return {}
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		return parsed !== null && typeof parsed === 'object' ? parsed : {}
	} catch (error) {
		logger?.warn?.(`bicameral-mind: settings file is unreadable (${error?.message ?? error}); using composition config`)
		return {}
	}
}

/** Persist the runtime settings file atomically (temp file + rename). */
export function writeSettings(home, settings, logger) {
	const file = settingsPath(home)
	const temporary = `${file}.${process.pid}.tmp`
	try {
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
		renameSync(temporary, file)
		return true
	} catch (error) {
		logger?.warn?.(`bicameral-mind: settings file not written (${error?.message ?? error})`)
		return false
	}
}

/** Normalize one candidate route list. */
function normalizeCandidates(value) {
	if (!Array.isArray(value)) return []
	const out = []
	for (const item of value) {
		if (item === null || typeof item !== 'object') continue
		const provider = str(item.provider)
		const model = str(item.model)
		if (provider.length === 0 || model.length === 0) continue
		const candidate = { provider, model }
		const effort = str(item.reasoningEffort)
		if (effort.length > 0) candidate.reasoningEffort = effort
		out.push(candidate)
	}
	return out
}

/**
 * Normalize one voice's route configuration.
 *
 * `provider` + `model` is the exact pin. `candidates` is the failover chain.
 * `fallbackToAgentRoute` appends the live session's own route and the process
 * default, so an unreachable pinned model degrades to the actor's model instead
 * of breaking the review.
 */
function normalizeVoiceRole(raw) {
	const value = raw !== null && typeof raw === 'object' ? raw : {}
	return {
		provider: str(value.provider),
		model: str(value.model),
		reasoningEffort: str(value.reasoningEffort),
		candidates: normalizeCandidates(value.candidates),
		fallbackToAgentRoute: value.fallbackToAgentRoute !== false,
		temperature: clampNumber(value.temperature, 0, 1),
		maxTokensQuick: clampInt(value.maxTokensQuick, 200, 6000, 1600),
		maxTokensFull: clampInt(value.maxTokensFull, 300, 10000, 2200),
	}
}

/** Merge layered raw objects: defaults ← composition config ← settings file ← live override. */
function layered(...sources) {
	const out = {}
	for (const source of sources) {
		if (source === null || typeof source !== 'object') continue
		for (const [key, value] of Object.entries(source)) {
			if (value === undefined) continue
			out[key] = value
		}
	}
	return out
}

/**
 * Merge the composition config, the runtime settings file, and an in-flight
 * command override into the single normalized shape the plugin reads.
 *
 * @param config - the composition row config (may be empty).
 * @param fileSettings - persisted user choices (may be empty).
 * @param overrides - process-local choices made by `/bicameral`.
 * @returns the normalized configuration.
 */
export function normalizeConfig(config, fileSettings = {}, overrides = {}) {
	const base = config !== null && typeof config === 'object' ? config : {}
	const file = fileSettings !== null && typeof fileSettings === 'object' ? fileSettings : {}
	const live = overrides !== null && typeof overrides === 'object' ? overrides : {}

	const rawActor = layered(base.voices?.actor, file.voices?.actor, live.voices?.actor, base.voice?.actor)
	const rawExaminer = layered(base.voices?.examiner, file.voices?.examiner, live.voices?.examiner, base.voice?.examiner, base.voice)
	const rawAuto = layered(base.autoReview, file.autoReview, live.autoReview)
	const rawTool = layered(base.tool, file.tool, live.tool)

	const enabled = [live.enabled, file.enabled, base.enabled].find((value) => typeof value === 'boolean')
	const language = [live.language, file.language, base.language].find((value) => ['zh', 'en', 'auto'].includes(value)) ?? 'auto'
	const intervention = [live.intervention, file.intervention, base.intervention].find((value) =>
		['off', 'advisory', 'balanced', 'strict', 'paranoid', 'custom'].includes(value),
	) ?? 'custom'
	const maxIssuesRaw = [live.maxIssues, file.maxIssues, base.maxIssues].find((value) => Number.isFinite(value))

	return {
		enabled: enabled !== false,
		language,
		intervention,
		maxIssues: clampInt(maxIssuesRaw, 1, 5, 3),
		voices: {
			actor: normalizeVoiceRole(rawActor),
			examiner: normalizeVoiceRole(rawExaminer),
		},
		autoReview: {
			enabled: rawAuto.enabled !== false,
			tools: strList(rawAuto.tools, DEFAULT_REVIEW_TOOLS),
			cooldownMs: clampInt(rawAuto.cooldownMs, 0, 600000, 15000),
			maxPerTurn: clampInt(rawAuto.maxPerTurn, 1, 50, 6),
			timeoutMs: clampInt(rawAuto.timeoutMs, 2000, 120000, 20000),
			maxTokens: clampInt(rawAuto.maxTokens, 200, 4000, 700),
			includeErrors: rawAuto.includeErrors !== false,
			subagents: rawAuto.subagents === true,
			logPasses: rawAuto.logPasses === true,
			finishGate: rawAuto.finishGate !== false,
			// Stronger levels review the final answer even with no pending issues.
			finishAlways: rawAuto.finishAlways === true,
			// Read-only shell commands are not reviewed: reviewing `Get-Content`
			// produced false "you wrote README" objections.
			shellReadGuard: rawAuto.shellReadGuard !== false,
		},
		tool: {
			defaultDepth: rawTool.defaultDepth === 'full' ? 'full' : 'quick',
			fullStages: strList(rawTool.fullStages, DEFAULT_FULL_STAGES),
			timeoutMs: clampInt(rawTool.timeoutMs, 2000, 300000, 30000),
		},
	}
}
