/**
 * Small, dependency-free helpers shared by the Bicameral Mind host plugin.
 *
 * Everything here is pure and synchronous. The only Node builtin used is the
 * random UUID source for injected message identities, which matches what
 * `createUserMessage()` in `@deepseek-ai/dsh-llm` produces: a fresh id, the
 * `user` role, exact content blocks, and a producer source.
 *
 * @module dsh-bicameral-mind/util
 */
import { randomUUID } from 'node:crypto'

/** Collapse any thrown value into a short human message. */
export function messageOf(error) {
	if (error instanceof Error) return error.message
	try {
		return String(error)
	} catch {
		return 'unknown error'
	}
}

/** Bound one string, preserving a visible ellipsis marker. */
export function truncate(text, max) {
	const value = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text)
	const limit = Number.isSafeInteger(max) && max > 0 ? max : 0
	if (limit === 0) return ''
	if (value.length <= limit) return value
	return `${value.slice(0, Math.max(0, limit - 1))}…`
}

/** Join every text block of model-facing content. */
export function textOfContent(content) {
	if (!Array.isArray(content)) return ''
	const parts = []
	for (const block of content) {
		if (block === null || typeof block !== 'object') continue
		if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
	}
	return parts.join('\n')
}

/** A short JSON preview that never throws on hostile values. */
export function jsonPreview(value, max = 1200) {
	let text
	try {
		text = JSON.stringify(value)
	} catch {
		try {
			text = String(value)
		} catch {
			text = '<unserializable>'
		}
	}
	return truncate(text ?? 'null', max)
}

/** Whether a message came from the human user rather than a plugin or a model. */
export function isHumanMessage(message) {
	const source = message?.source
	return source !== null && typeof source === 'object' && source.kind === 'user'
}

/** Build one identified user-role message for `additionalContexts` / inbox injection. */
export function createInjectedMessage(text, sourceKind = 'plugin:bicameral-mind') {
	const body = typeof text === 'string' ? text : String(text ?? '')
	return Object.freeze({
		id: randomUUID(),
		role: 'user',
		content: Object.freeze([Object.freeze({ type: 'text', text: body })]),
		source: Object.freeze({ kind: sourceKind }),
	})
}

/** Clamp an integer with a fallback. */
export function clampInt(value, min, max, fallback) {
	const number = typeof value === 'number' ? value : Number.NaN
	if (!Number.isFinite(number)) return fallback
	const rounded = Math.trunc(number)
	return Math.min(max, Math.max(min, rounded))
}

/** Clamp an optional number (undefined stays undefined). */
export function clampNumber(value, min, max) {
	const number = typeof value === 'number' ? value : Number.NaN
	if (!Number.isFinite(number)) return undefined
	return Math.min(max, Math.max(min, number))
}

/** Trimmed string or empty. */
export function str(value) {
	return typeof value === 'string' ? value.trim() : ''
}

/** String array with a fallback and de-duplication, preserving order. */
export function strList(value, fallback) {
	const source = Array.isArray(value) ? value : fallback
	const out = []
	for (const item of source) {
		if (typeof item !== 'string') continue
		const trimmed = item.trim()
		if (trimmed.length === 0 || out.includes(trimmed)) continue
		out.push(trimmed)
	}
	return out
}

/** Human-readable duration for command output. */
export function formatMs(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '?'
	if (ms < 1000) return `${Math.round(ms)}ms`
	return `${(ms / 1000).toFixed(1)}s`
}

/** One clock reading used for ordering transcripts. */
export function nowMs() {
	return Date.now()
}
