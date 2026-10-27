/**
 * The examiner's own model call.
 *
 * 右脑 must be a genuinely different voice, so it is produced by an independent
 * model request rather than by the actor's own stream of thought. This module
 * owns route resolution (explicit override → candidate chain → the agent's own
 * route → the process default), the streaming call with timeout and
 * cancellation, and the failover that keeps the actor alive when no voice model
 * is reachable.
 *
 * @module dsh-bicameral-mind/voice
 */
import { messageOf, truncate } from './util.js'

/** Default per-call ceiling for one examiner/advocate utterance. */
const DEFAULT_TIMEOUT_MS = 30000

/** Collapse a model + provider pair into a stable key. */
function routeKey(route) {
	return `${route.provider}\u0000${route.model}`
}

/** Whether one candidate is structurally usable. */
function usable(route) {
	return route !== undefined && route !== null && typeof route.provider === 'string' && route.provider.length > 0
		&& typeof route.model === 'string' && route.model.length > 0
}

/**
 * Resolve the ordered list of routes the voice may use.
 *
 * Order: an explicit `voice.provider` + `voice.model` pair, then every configured
 * candidate, then the live session's own route (the actor's model), then the
 * process default selection. Duplicates are dropped by provider/model pair.
 *
 * @param ctx - host context (only `get()` is used).
 * @param agent - the acting agent, when one exists.
 * @param voice - normalized voice configuration.
 * @returns a de-duplicated candidate list, best first.
 */
export function resolveVoiceRoutes(ctx, agent, voice) {
	const routes = []
	const push = (candidate) => {
		if (!usable(candidate)) return
		const normalized = {
			provider: candidate.provider,
			model: candidate.model,
			...(typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort.length > 0
				? { reasoningEffort: candidate.reasoningEffort }
				: {}),
		}
		const key = routeKey(normalized)
		if (routes.some((existing) => routeKey(existing) === key)) return
		routes.push(normalized)
	}

	if (typeof voice?.provider === 'string' && voice.provider.length > 0 && typeof voice?.model === 'string' && voice.model.length > 0) {
		push({ provider: voice.provider, model: voice.model, reasoningEffort: voice.reasoningEffort })
	}
	for (const candidate of Array.isArray(voice?.candidates) ? voice.candidates : []) {
		push({
			provider: candidate?.provider,
			model: candidate?.model,
			reasoningEffort: candidate?.reasoningEffort ?? voice?.reasoningEffort,
		})
	}
	if (voice?.fallbackToAgentRoute !== false && agent !== undefined && agent !== null) {
		try {
			const header = agent.session?.requestHeader?.()
			const config = header?.config
			if (usable(config)) push({ provider: config.provider, model: config.model })
		} catch {
			/* a diagnostic session without a live agent is fine */
		}
		if (routes.length === 0 && usable(agent.options)) {
			push({ provider: agent.options.provider, model: agent.options.model })
		}
	}
	if (voice?.fallbackToAgentRoute !== false) {
		try {
			const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
			if (usable(selection)) push({ provider: selection.provider, model: selection.model })
		} catch {
			/* optional service */
		}
	}
	return routes
}

/** One accounting record returned by {@link callVoice}. */
function failure(error, route, elapsedMs) {
	return {
		ok: false,
		provider: route?.provider,
		model: route?.model,
		error: truncate(messageOf(error), 400),
		elapsedMs,
	}
}

/**
 * Stream one utterance from one model route.
 *
 * The returned value never rejects: a missing adapter, provider failure,
 * timeout, or turn cancellation all resolve to `{ ok: false }` so the caller can
 * try the next candidate or degrade the actor's step gracefully.
 *
 * @param ctx - host context exposing `llm`.
 * @param options - route, prompts, token cap, temperature, cancellation, timeout.
 * @returns `{ ok: true, text, usage }` or `{ ok: false, error }`.
 */
export async function callVoice(ctx, options) {
	const {
		route,
		system,
		user,
		maxTokens,
		temperature,
		signal,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = options ?? {}
	const startedAt = Date.now()
	const llm = ctx.get?.('llm')
	if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
		return failure(new Error('llm service unavailable'), route, 0)
	}
	const controller = new AbortController()
	const onAbort = () => {
		try {
			controller.abort(signal?.reason)
		} catch {
			controller.abort()
		}
	}
	if (signal?.aborted === true) onAbort()
	else signal?.addEventListener?.('abort', onAbort, { once: true })
	const timer = setTimeout(() => {
		try {
			controller.abort(new Error(`voice timed out after ${timeoutMs}ms`))
		} catch {
			controller.abort()
		}
	}, Math.max(1000, timeoutMs))

	const request = {
		provider: route.provider,
		model: route.model,
		system: typeof system === 'string' ? system : '',
		messages: [{ role: 'user', content: [{ type: 'text', text: typeof user === 'string' ? user : '' }] }],
		signal: controller.signal,
	}
	if (Number.isSafeInteger(maxTokens) && maxTokens > 0) request.maxTokens = maxTokens
	if (typeof temperature === 'number' && Number.isFinite(temperature)) request.temperature = temperature
	if (typeof route.reasoningEffort === 'string' && route.reasoningEffort.length > 0) request.reasoningEffort = route.reasoningEffort

	let text = ''
	let usage
	let finish
	let thrown
	// A cooperative abort is not enough: an adapter that ignores its signal
	// would otherwise hang the caller forever. The hard deadline settles the
	// promise even when the stream never does; the abandoned iterator is
	// aborted and its late rejection silenced.
	const consume = (async () => {
		for await (const chunk of llm.stream(request)) {
			if (chunk === null || typeof chunk !== 'object') continue
			if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
			else if (chunk.type === 'usage') usage = chunk.usage
			else if (chunk.type === 'finish') finish = chunk.reason
		}
	})().then(
		() => 'done',
		(error) => {
			thrown = error
			return 'error'
		},
	)
	let hardTimer
	const hardDeadline = new Promise((resolve) => {
		hardTimer = setTimeout(() => {
			try {
				controller.abort(new Error('voice hard deadline'))
			} catch {
				/* already aborted */
			}
			resolve('hard-deadline')
		}, Math.max(2000, timeoutMs + 3000))
	})
	const settled = await Promise.race([consume, hardDeadline])
	clearTimeout(timer)
	if (hardTimer !== undefined) clearTimeout(hardTimer)
	signal?.removeEventListener?.('abort', onAbort)
	if (settled === 'hard-deadline') {
		consume.catch?.(() => {})
		return failure(new Error(`voice hard deadline after ${timeoutMs}ms`), route, Date.now() - startedAt)
	}
	if (thrown !== undefined) return failure(thrown, route, Date.now() - startedAt)

	if (finish !== undefined) {
		if (finish.kind === 'error') return failure(new Error(finish.failure?.message ?? 'model request failed'), route, Date.now() - startedAt)
		if (finish.kind === 'aborted') return failure(new Error(finish.failure?.message ?? 'model request aborted'), route, Date.now() - startedAt)
	}
	const trimmed = text.trim()
	if (trimmed.length === 0) return failure(new Error('model returned no text'), route, Date.now() - startedAt)
	return { ok: true, text: trimmed, provider: route.provider, model: route.model, usage, elapsedMs: Date.now() - startedAt }
}

/**
 * Try every candidate route in order and return the first usable utterance.
 *
 * @param ctx - host context.
 * @param routes - ordered candidates from {@link resolveVoiceRoutes}.
 * @param options - prompts, token cap, timeout, cancellation, and a narration hook.
 * @returns the first successful call, or the last failure plus every attempt.
 */
export async function callFirstVoice(ctx, routes, options) {
	const attempts = []
	if (!Array.isArray(routes) || routes.length === 0) {
		return { ok: false, attempts, error: 'no voice route is available' }
	}
	for (const route of routes) {
		const result = await callVoice(ctx, { ...options, route })
		if (result.ok) return { ...result, attempts }
		attempts.push({ provider: route.provider, model: route.model, error: result.error })
		options?.onAttempt?.(route, result)
	}
	return { ok: false, attempts, error: attempts.at(-1)?.error ?? 'all voice routes failed' }
}

/** Probe one route with a minimal request, for `/bicameral probe`. */
export async function probeRoute(ctx, route, timeoutMs = 20000) {
	const startedAt = Date.now()
	const result = await callVoice(ctx, {
		route,
		system: 'You are a connectivity probe. Reply with exactly: OK',
		user: 'Reply with exactly: OK',
		maxTokens: 16,
		temperature: 0,
		timeoutMs,
	})
	return { ...result, elapsedMs: Date.now() - startedAt }
}
