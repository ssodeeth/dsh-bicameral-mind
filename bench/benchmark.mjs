#!/usr/bin/env node
/**
 * Deterministic cost benchmark for the intervention levels and cost guardrails.
 *
 * It replaces the model call with an instant fake that always returns a passing
 * verdict, then simulates a fixed workload of consequential / read-only tool
 * calls. The numbers are therefore NOT wall-clock model latency; they are the
 * number of reviewer calls, estimated tokens and budget blocks the plugin would
 * cause for the same workload under each configuration.
 *
 * Run: npm run bench
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '../src/runtime.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bicameral-bench-'))

const STEPS = 12
const TOOL_NAMES = ['write', 'read', 'pwsh']
const TOOL_ARGS = {
	write: { path: 'out.txt', content: 'hello' },
	read: { path: 'out.txt' },
	pwsh: { command: 'Get-Content out.txt' },
}
const BUDGETS = {
	standard: { enabled: true, maxCallsPerTurn: 12, maxFullDebatesPerTurn: 3, maxTokensPerTurn: 24000 },
	frugal: { enabled: true, maxCallsPerTurn: 6, maxFullDebatesPerTurn: 1, maxTokensPerTurn: 12000 },
}

function fakeCtx() {
	let calls = 0
	let tokens = 0
	const llm = {
		async *stream(options) {
			calls += 1
			tokens += Number.isSafeInteger(options?.maxTokens) ? options.maxTokens : 0
			yield { type: 'text-delta', index: 0, text: '{"verdict":"pass","summary":"ok","issues":[],"questions":[]}' }
			yield { type: 'finish', reason: { kind: 'stop' } }
		},
		listProviders: () => [],
		listModels: async () => [],
	}
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: { register: () => () => {} },
		systemPrompt: { section: () => () => {} },
		effect(fn) {
			const dispose = fn()
			return typeof dispose === 'function' ? dispose : () => {}
		},
		on: () => () => {},
		inject: () => {},
		get(name) {
			if (name === 'llm') return llm
			if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'bench-provider', model: 'bench-model' }) }
			return undefined
		},
	}
	return { ctx, usage: () => ({ calls, tokens }) }
}

function fakeAgent() {
	return {
		id: 'bench-session',
		options: { provider: 'bench-provider', model: 'bench-model' },
		session: {
			header: { origin: 'session' },
			requestHeader: () => ({ config: { provider: 'bench-provider', model: 'bench-model' } }),
			deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
		},
		steer() {},
	}
}

async function runScenario(level, budgetName) {
	const { ctx, usage } = fakeCtx()
	const runtime = createRuntime(ctx, {})
	runtime.applyLevel(level)
	runtime.applyEditablePatch({
		autoReview: { cooldownMs: 0, maxPerTurn: 50 },
		budget: BUDGETS[budgetName],
	})
	const agent = fakeAgent()
	const signal = new AbortController().signal
	const next = async () => ({ kind: 'enter', messages: [] })
	await runtime.handlePreStep(
		{
			agent,
			messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '固定基准任务' }], source: { kind: 'user' } }],
			turn: 1,
			step: 1,
			signal,
		},
		next,
	)
	const started = performance.now()
	for (let index = 0; index < STEPS; index += 1) {
		const name = TOOL_NAMES[index % TOOL_NAMES.length]
		runtime.onToolResult(
			{ name, agent, arguments: TOOL_ARGS[name] },
			{ isError: false, content: [{ type: 'text', text: 'ok' }] },
		)
		await runtime.handlePreStep({ agent, messages: [], turn: 1, step: index + 2, signal }, next)
	}
	const elapsed = performance.now() - started
	const state = runtime.store.peek(agent.id)
	const { calls, tokens } = usage()
	return {
		level,
		budget: budgetName,
		calls,
		reservedCalls: state.budgetCalls,
		full: state.budgetFull,
		estimatedTokens: state.budgetTokens,
		blocked: state.budgetSkipped,
		overheadMs: elapsed,
	}
}

function pad(value, width) {
	return String(value).padStart(width)
}

const rows = []
for (const level of ['balanced', 'strict', 'paranoid']) {
	for (const budget of ['standard', 'frugal']) {
		rows.push(await runScenario(level, budget))
	}
}

console.log(`Bicameral Mind cost benchmark — same ${STEPS}-step workload (write/read/pwsh repeated), fake model returns pass instantly.`)
console.log('calls = actual reviewer calls; reserved = conservative budget charge (a full debate reserves 3); these are not wall-clock latency.')
console.log('')
console.log(['level'.padEnd(10), 'budget'.padEnd(9), 'calls'.padStart(6), 'reserved'.padStart(9), 'full'.padStart(5), 'tokens'.padStart(8), 'blocked'.padStart(8), 'plugin ms'.padStart(10)].join(''))
console.log(['-'.repeat(10), '-'.repeat(9), '-'.repeat(6), '-'.repeat(9), '-'.repeat(5), '-'.repeat(8), '-'.repeat(8), '-'.repeat(10)].join(' '))
for (const row of rows) {
	console.log([
		row.level.padEnd(10),
		row.budget.padEnd(9),
		pad(row.calls, 6),
		pad(row.reservedCalls, 9),
		pad(row.full, 5),
		pad(row.estimatedTokens, 8),
		pad(row.blocked, 8),
		pad(row.overheadMs.toFixed(1), 10),
	].join(''))
}
