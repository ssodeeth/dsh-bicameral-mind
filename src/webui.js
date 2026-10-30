/**
 * Read-only diagnostics routes for the Web UI panel.
 *
 * The panel is a thin client: the Host folds one small JSON snapshot for the
 * calling session (settings, both voice routes, and the bounded transcript) and
 * serves it here. The route only exists when both `webServer` and `connection`
 * are mounted, and every request passes the Host's browser trust fence
 * (`requestRejection`), so a cross-site, mismatched-Origin, unauthenticated, or
 * non-loopback request is refused. A throwing fence fails closed.
 *
 * @module dsh-bicameral-mind/webui
 */

/** Snapshot route served to the panel. */
export const STATE_PATH = '/bicameral-mind/state'

/** Toggle route used by the panel's on/off control. */
export const TOGGLE_PATH = '/bicameral-mind/toggle'

/** Settings page: read/patch the editable configuration. */
export const CONFIG_PATH = '/bicameral-mind/config'

/** Settings page: provider/model catalog for the pickers. */
export const MODELS_PATH = '/bicameral-mind/models'

/** Settings page: probe one explicit voice route. */
export const PROBE_PATH = '/bicameral-mind/probe'

/** Settings page: apply one intervention level preset. */
export const LEVEL_PATH = '/bicameral-mind/level'

/** Settings page: apply one cost-guardrail preset. */
export const BUDGET_PATH = '/bicameral-mind/budget'

/** Inner-dialogue view: resolve or clear outstanding issues. */
export const ISSUES_PATH = '/bicameral-mind/issues'

/** Composer picker: per-session examiner route override. */
export const SESSION_VOICE_PATH = '/bicameral-mind/session-voice'

/** Read a bounded JSON request body; an oversized body is drained and rejected. */
async function readJsonBody(req, limit = 8192) {
	const chunks = []
	let total = 0
	for await (const chunk of req) {
		total += chunk.length
		if (total > limit) {
			try {
				req.resume?.()
			} catch {
				/* the stream may already be gone */
			}
			throw new Error('request body too large')
		}
		chunks.push(chunk)
	}
	const raw = Buffer.concat(chunks).toString('utf8')
	return raw.length === 0 ? {} : JSON.parse(raw)
}

/** Send one JSON response. */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.end(body)
}

/**
 * Browser trust fence for one request.
 *
 * @returns the HTTP status to refuse with, or `undefined` to serve.
 */
function fence(scope, req) {
	try {
		const headers = req?.headers ?? {}
		let hostUrl
		try {
			hostUrl = new URL(`http://${String(headers.host ?? '')}`)
		} catch {
			return 403
		}
		if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
		const origin = headers.origin
		if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
			try {
				if (new URL(origin).host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
			} catch {
				return 403
			}
		}
		const connection = scope.get?.('connection')
		if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
			// The routes are only registered with a live connection; if it vanished,
			// fail closed instead of serving session data.
			return 503
		}
		let code
		try {
			code = connection.requestRejection(req)
		} catch {
			return 403
		}
		if (code === undefined || code === null || code === false) return undefined
		return typeof code === 'number' ? code : 403
	} catch {
		return 403
	}
}

/** Register the two diagnostics routes on the owning scope's web server. */
export function registerWebUi(scope, runtime) {
	const webServer = scope.webServer
	const disposers = []

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: STATE_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method !== 'GET') {
					res.setHeader('allow', 'GET')
					sendJson(res, 405, { ok: false, message: 'GET required' })
					return
				}
				try {
					const url = new URL(req.url ?? STATE_PATH, 'http://127.0.0.1')
					const sessionId = url.searchParams.get('sessionId')
					if (typeof sessionId !== 'string' || sessionId.length === 0) {
						sendJson(res, 400, { ok: false, message: 'sessionId is required' })
						return
					}
					sendJson(res, 200, { ok: true, ...runtime.snapshot(sessionId) })
				} catch (error) {
					sendJson(res, 500, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: TOGGLE_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method !== 'POST') {
					res.setHeader('allow', 'POST')
					sendJson(res, 405, { ok: false, message: 'POST required' })
					return
				}
				try {
					const body = await readJsonBody(req)
					if (typeof body?.enabled !== 'boolean') {
						sendJson(res, 400, { ok: false, message: 'enabled must be a boolean' })
						return
					}
					const outcome = runtime.applyChange((settings) => {
						settings.enabled = body.enabled
					})
					if (!outcome.ok) {
						sendJson(res, 500, { ok: false, message: outcome.error ?? 'settings were not persisted' })
						return
					}
					sendJson(res, 200, { ok: true, enabled: runtime.current().enabled })
				} catch (error) {
					sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: CONFIG_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method === 'GET') {
					try {
						sendJson(res, 200, { ok: true, ...runtime.configView() })
					} catch (error) {
						sendJson(res, 500, { ok: false, message: error?.message ?? String(error) })
					}
					return
				}
				if (req.method !== 'POST') {
					res.setHeader('allow', 'GET, POST')
					sendJson(res, 405, { ok: false, message: 'GET or POST required' })
					return
				}
				try {
					const body = await readJsonBody(req, 32768)
					const outcome = runtime.applyEditablePatch(body?.patch)
					if (!outcome.ok) {
						sendJson(res, 400, { ok: false, message: outcome.message ?? outcome.error ?? '配置校验失败' })
						return
					}
					sendJson(res, 200, { ok: true, ...runtime.configView() })
				} catch (error) {
					sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: MODELS_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method !== 'GET') {
					res.setHeader('allow', 'GET')
					sendJson(res, 405, { ok: false, message: 'GET required' })
					return
				}
				try {
					const url = new URL(req.url ?? MODELS_PATH, 'http://127.0.0.1')
					const catalog = await runtime.availableModels(url.searchParams.get('force') === '1')
					sendJson(res, 200, { ok: true, ...catalog })
				} catch (error) {
					sendJson(res, 500, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: PROBE_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method !== 'POST') {
					res.setHeader('allow', 'POST')
					sendJson(res, 405, { ok: false, message: 'POST required' })
					return
				}
				try {
					const body = await readJsonBody(req, 8192)
					const result = await runtime.probeVoice(body)
					sendJson(res, 200, { ok: result.ok === true, elapsedMs: result.elapsedMs, error: result.error ?? '' })
				} catch (error) {
					sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: LEVEL_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method !== 'POST') {
					res.setHeader('allow', 'POST')
					sendJson(res, 405, { ok: false, message: 'POST required' })
					return
				}
				try {
					const body = await readJsonBody(req, 8192)
					const outcome = runtime.applyLevel(body?.level)
					if (!outcome.ok) {
						sendJson(res, 400, { ok: false, message: outcome.message ?? outcome.error ?? '档位应用失败' })
						return
					}
					sendJson(res, 200, { ok: true, ...runtime.configView() })
				} catch (error) {
					sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: BUDGET_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method !== 'POST') {
					res.setHeader('allow', 'POST')
					sendJson(res, 405, { ok: false, message: 'POST required' })
					return
				}
				try {
					const body = await readJsonBody(req, 8192)
					const outcome = runtime.applyBudgetPreset(body?.tier)
					if (!outcome.ok) {
						sendJson(res, 400, { ok: false, message: outcome.message ?? outcome.error ?? '成本档位应用失败' })
						return
					}
					sendJson(res, 200, { ok: true, ...runtime.configView() })
				} catch (error) {
					sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: ISSUES_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method !== 'POST') {
					res.setHeader('allow', 'POST')
					sendJson(res, 405, { ok: false, message: 'POST required' })
					return
				}
				try {
					const body = await readJsonBody(req, 8192)
					const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
					if (sessionId.length === 0) {
						sendJson(res, 400, { ok: false, message: 'sessionId is required' })
						return
					}
					const result = body?.all === true
						? runtime.clearIssues(sessionId)
						: runtime.resolveIssues(sessionId, body?.problems)
					if (!result.ok) {
						sendJson(res, result.message === 'session not found' ? 404 : 400, { ok: false, message: result.message })
						return
					}
					sendJson(res, 200, { ok: true, resolved: result.resolved, remaining: result.remaining })
				} catch (error) {
					sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	disposers.push(
		webServer.register({
			kind: 'exact',
			path: SESSION_VOICE_PATH,
			handler: async (req, res) => {
				const refusal = fence(scope, req)
				if (refusal !== undefined) {
					res.statusCode = refusal
					res.end()
					return
				}
				if (req.method !== 'POST') {
					res.setHeader('allow', 'POST')
					sendJson(res, 405, { ok: false, message: 'POST required' })
					return
				}
				try {
					const body = await readJsonBody(req, 8192)
					const result = runtime.setSessionExaminer(body?.sessionId, body)
					if (!result.ok) {
						sendJson(res, 400, { ok: false, message: result.message })
						return
					}
					sendJson(res, 200, { ok: true, ...result })
				} catch (error) {
					sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
				}
			},
		}),
	)

	return () => {
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				/* the socket may already be gone */
			}
		}
	}
}
