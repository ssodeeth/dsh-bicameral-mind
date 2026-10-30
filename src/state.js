/**
 * Per-session derived state for the two voices.
 *
 * The durable session log stays the single source of truth for what the model
 * may see; this store is a bounded, in-memory cache of what the plugin itself
 * observed (last human task, recent actions, examiner verdicts, transcripts).
 * It never feeds the model directly except through logged channels — a tool
 * result or an identified user message entering a step.
 *
 * @module dsh-bicameral-mind/state
 */
import { nowMs, textOfContent, truncate } from './util.js'

/** How many actions one review may see as evidence. */
const MAX_ACTIONS = 8
/** How many transcripts are retained per session. */
const MAX_ENTRIES = 40
/** How many sessions are retained in the diagnostics snapshot. */
const MAX_SESSIONS = 30
/** Cap on outstanding examiner issues per session. */
const MAX_PENDING = 6

/** Stable identity for one issue: its normalized problem text. */
function issueKey(issue) {
	const problem = typeof issue?.problem === 'string' ? issue.problem.trim() : ''
	return `${problem.slice(0, 120)}\u0000${issue?.severity === 'must' ? 'must' : 'should'}`
}

/** Normalize problem text for resolved/outstanding matching. */
function normalizeProblem(value) {
	return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Whether one outstanding issue is the one the examiner just resolved. */
function matchesResolved(issue, resolvedText) {
	const a = normalizeProblem(issue?.problem)
	const b = normalizeProblem(resolvedText)
	if (a.length < 6 || b.length < 6) return false
	return a === b || a.includes(b) || b.includes(a)
}

/** Bound one transcript entry's long fields before it is stored or shown. */
function boundEntry(entry) {
	const issues = Array.isArray(entry.issues)
		? entry.issues.slice(0, 5).map((issue) => ({
				severity: issue?.severity === 'must' ? 'must' : 'should',
				problem: truncate(issue?.problem, 400),
				evidence: truncate(issue?.evidence, 400),
				fix: truncate(issue?.fix, 400),
			}))
		: []
	const transcript = entry.transcript && typeof entry.transcript === 'object'
		? {
				advocate: truncate(entry.transcript.advocate ?? entry.transcript.claim, 900),
				critique: truncate(entry.transcript.critique, 1600),
				reply: truncate(entry.transcript.reply, 1200),
				final: truncate(entry.transcript.final, 1200),
			}
		: undefined
	return {
		at: entry.at,
		origin: entry.origin === 'auto' ? 'auto' : entry.origin === 'command' ? 'command' : 'tool',
		stage: typeof entry.stage === 'string' ? entry.stage : 'act',
		verdict: typeof entry.verdict === 'string' ? entry.verdict : 'revise',
		summary: truncate(entry.summary, 600),
		issues,
		questions: Array.isArray(entry.questions) ? entry.questions.slice(0, 3).map((q) => truncate(q, 300)) : [],
		...(transcript === undefined ? {} : { transcript }),
		...(typeof entry.toolName === 'string' ? { toolName: entry.toolName } : {}),
		...(typeof entry.model === 'string' ? { model: entry.model } : {}),
		...(typeof entry.provider === 'string' ? { provider: entry.provider } : {}),
	}
}

/** One live session's observed two-voice context. */
function freshSession(sessionId) {
	return {
		sessionId,
		createdAt: nowMs(),
		touchedAt: nowMs(),
		task: '',
		taskAt: 0,
		taskTurn: -1,
		/** Latest human instruction; may refine, but never replaces, the anchor. */
		latestHuman: '',
		latestAt: 0,
		turn: 0,
		step: 0,
		/** Auto reviews already spent in the current turn. */
		autoCount: 0,
		autoTurn: -1,
		lastAutoAt: 0,
		/** Cost guardrail counters for the current turn. */
		budgetTurn: -1,
		budgetCalls: 0,
		budgetFull: 0,
		budgetTokens: 0,
		budgetSkipped: 0,
		/** Set while an examiner request is in flight for this session. */
		reviewing: false,
		/** Consequential action waiting for the next step boundary, if any. */
		pendingTrigger: undefined,
		/** Outstanding examiner issues the actor has not resolved yet. */
		pendingIssues: [],
		pendingAt: 0,
		/** Bounded rolling window of consequential actions, for evidence. */
		actions: [],
		/** Newest-first transcript entries. */
		entries: [],
	}
}

/** Bounded, per-session view of the two voices. */
export class BicameralStore {
	constructor() {
		this.sessions = new Map()
	}

	/** Read (or lazily create) one session's state. */
	stateFor(sessionId) {
		const key = typeof sessionId === 'string' ? sessionId : String(sessionId)
		let state = this.sessions.get(key)
		if (state === undefined) {
			state = freshSession(key)
			this.sessions.set(key, state)
			this.#evictSessions()
		}
		state.touchedAt = nowMs()
		return state
	}

	/** Read one session's state without creating it. */
	peek(sessionId) {
		return this.sessions.get(sessionId)
	}

	/** Drop one session (agent disposal). */
	remove(sessionId) {
		this.sessions.delete(sessionId)
	}

	/**
	 * Remember the newest human instruction.
	 *
	 * The first human message of a session becomes the task anchor and is kept:
	 * a later "继续" or refinement must not erase the original goal, or the
	 * examiner would lose the only stable reference for judging drift. The
	 * latest message is retained separately and shown alongside the anchor.
	 */
	recordHumanTask(sessionId, text, turn) {
		const trimmed = truncate(typeof text === 'string' ? text.trim() : '', 1500)
		if (trimmed.length === 0) return
		const state = this.stateFor(sessionId)
		state.latestHuman = trimmed
		state.latestAt = nowMs()
		if (state.task.length === 0) {
			state.task = trimmed
			state.taskAt = nowMs()
			if (Number.isSafeInteger(turn)) state.taskTurn = turn
		}
	}

	/** Remember one consequential action for later evidence. */
	recordAction(sessionId, action) {
		const state = this.stateFor(sessionId)
		state.actions.push({
			at: nowMs(),
			name: truncate(action?.name, 80),
			arguments: truncate(action?.arguments, 900),
			result: truncate(action?.result, 900),
			isError: action?.isError === true,
		})
		if (state.actions.length > MAX_ACTIONS) state.actions.splice(0, state.actions.length - MAX_ACTIONS)
	}

	/** Recent actions rendered as compact evidence text. */
	evidenceFromActions(sessionId, limit = 4) {
		const state = this.peek(sessionId)
		if (state === undefined) return ''
		const recent = state.actions.slice(-limit)
		if (recent.length === 0) return ''
		return recent
			.map((action, index) => {
				const tail = action.result.length > 0 ? `\n   结果：${action.result}` : ''
				const failure = action.isError ? '（失败）' : ''
				return `${index + 1}. 工具 ${action.name}${failure}\n   参数：${action.arguments}${tail}`
			})
			.join('\n')
	}

	/** Mark one consequential action as awaiting the next step boundary. */
	markTrigger(sessionId, name) {
		const state = this.stateFor(sessionId)
		state.pendingTrigger = { name: truncate(name, 80), at: nowMs() }
	}

	/** Read and clear the pending trigger in one call. */
	takeTrigger(sessionId) {
		const state = this.peek(sessionId)
		if (state === undefined || state.pendingTrigger === undefined) return undefined
		const trigger = state.pendingTrigger
		state.pendingTrigger = undefined
		return trigger
	}

	/** Drop a pending trigger without reviewing it. */
	clearTrigger(sessionId) {
		const state = this.peek(sessionId)
		if (state !== undefined) state.pendingTrigger = undefined
	}

	/** Append one bounded transcript entry (newest first). */
	recordEntry(sessionId, entry) {
		const state = this.stateFor(sessionId)
		const bounded = boundEntry({ at: nowMs(), ...entry })
		state.entries.unshift(bounded)
		if (state.entries.length > MAX_ENTRIES) state.entries.length = MAX_ENTRIES
		return bounded
	}

	/**
	 * Fold one review result into the outstanding issue set.
	 *
	 * Issues are merged, never wholesale replaced: an unrelated automatic pass
	 * must not erase a must-issue another action produced. A deliberate
	 * re-examination (`finish`/`checkpoint`, or an explicit tool call) may clear
	 * them on a pass, which is what lets the end-of-turn gate converge.
	 */
	recordReviewIssues(sessionId, { verdict, stage, issues, resolved, deliberate, turn, step }) {
		const state = this.stateFor(sessionId)
		const cleared = Array.isArray(resolved) ? resolved : []
		if (cleared.length > 0) {
			// The examiner may explicitly retire old issues when newer evidence
			// proves they were fixed; this is what keeps a step-1 objection from
			// haunting step 3.
			state.pendingIssues = state.pendingIssues.filter((issue) => !cleared.some((text) => matchesResolved(issue, text)))
		}
		if (verdict === 'pass') {
			const clears = deliberate === true || stage === 'finish' || stage === 'checkpoint'
			if (!clears) return
			state.pendingIssues = []
			state.pendingAt = nowMs()
			return
		}
		if (!Array.isArray(issues) || issues.length === 0) return
		const merged = new Map(state.pendingIssues.map((issue) => [issue.key, issue]))
		for (const issue of issues.slice(0, 3)) {
			const key = issueKey(issue)
			merged.set(key, {
				key,
				severity: issue?.severity === 'must' ? 'must' : 'should',
				problem: truncate(issue?.problem, 400),
				evidence: truncate(issue?.evidence, 400),
				fix: truncate(issue?.fix, 400),
				at: nowMs(),
				raisedTurn: Number.isSafeInteger(turn) ? turn : state.turn,
				raisedStep: Number.isSafeInteger(step) ? step : state.step,
			})
		}
		state.pendingIssues = [...merged.values()].slice(-MAX_PENDING)
		state.pendingAt = nowMs()
	}

	/** Render outstanding issues as the next review's prior context. */
	pendingIssuesText(sessionId) {
		const state = this.peek(sessionId)
		if (state === undefined || state.pendingIssues.length === 0) return ''
		return state.pendingIssues
			.map((issue, index) => {
				const age = Number.isSafeInteger(issue.raisedTurn) && issue.raisedTurn >= 0
					? `（第 ${issue.raisedTurn} 轮${Number.isSafeInteger(issue.raisedStep) ? ` step ${issue.raisedStep}` : ''}提出${state.turn > issue.raisedTurn ? `，${state.turn - issue.raisedTurn} 轮前` : ''}）`
					: ''
				return `${index + 1}. [${issue.severity}] ${issue.problem}${age} -> ${issue.fix}`
			})
			.join('\n')
	}

	/** Diagnostics snapshot for the Web panel and the command surface. */
	snapshot(sessionId) {
		const state = sessionId === undefined ? undefined : this.sessions.get(sessionId)
		if (state === undefined) return { sessions: [], total: 0 }
		return {
			sessions: [
				{
					sessionId: state.sessionId,
					task: truncate(state.task, 500),
					turn: state.turn,
					pendingIssues: state.pendingIssues.length,
					lastEntryAt: state.entries[0]?.at ?? 0,
					entries: state.entries.slice(0, 12),
				},
			],
			total: 1,
		}
	}

	/** Latest entry of one session, for `/bicameral last`. */
	lastEntry(sessionId) {
		return this.peek(sessionId)?.entries[0]
	}

	/** Bound session retention by recency. */
	#evictSessions() {
		if (this.sessions.size <= MAX_SESSIONS) return
		const ordered = [...this.sessions.values()].sort((left, right) => left.touchedAt - right.touchedAt)
		const excess = this.sessions.size - MAX_SESSIONS
		for (let index = 0; index < excess; index += 1) this.sessions.delete(ordered[index].sessionId)
	}
}

export { textOfContent }
