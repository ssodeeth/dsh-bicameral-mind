#!/usr/bin/env node
/**
 * Capability A/B kit for the Bicameral Mind plugin.
 *
 * It does not call a model itself: DSH/Harness runs the agent, this kit prepares
 * a fixed workspace, verifies the result with a script, and summarizes a results
 * file. That keeps the measurement about the agent's actual task performance.
 *
 * Commands:
 *   node bench/capability.mjs list
 *   node bench/capability.mjs prepare <task> <workspace> [--force]
 *   node bench/capability.mjs verify <task> <workspace>
 *   node bench/capability.mjs selftest
 *   node bench/capability.mjs report <results.json>
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tasksDir = join(here, 'tasks')

const TASKS = {
	't01-fix-bug': '修复 JS 函数并让 node:test 全绿',
	't02-csv-clean': '按规则清洗 CSV 并输出 JSON + 统计',
	't03-rename-api': '跨文件重命名导出函数，保持测试通过',
	't04-format-report': '按严格格式从笔记生成报告',
}

function taskDir(id) {
	if (!Object.hasOwn(TASKS, id)) throw new Error(`unknown task: ${id} (try: ${Object.keys(TASKS).join(', ')})`)
	return join(tasksDir, id)
}

function copyDir(source, target) {
	mkdirSync(target, { recursive: true })
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = join(source, entry.name)
		const to = join(target, entry.name)
		if (entry.isDirectory()) copyDir(from, to)
		else cpSync(from, to)
	}
}

function prepare(id, workspace, force) {
	const root = resolve(workspace)
	if (existsSync(root) && readdirSync(root).length > 0) {
		if (!force) throw new Error(`workspace is not empty: ${root} (use --force to replace it)`)
		rmSync(root, { recursive: true, force: true })
	}
	mkdirSync(root, { recursive: true })
	copyDir(join(taskDir(id), 'fixture'), root)
	console.log(`prepared ${id} at ${root}`)
}

function verify(id, workspace) {
	const root = resolve(workspace)
	const script = join(taskDir(id), 'verify.mjs')
	const result = spawnSync(process.execPath, [script, root], { stdio: 'inherit' })
	return result.status ?? 1
}

function selftest() {
	let failed = 0
	for (const id of Object.keys(TASKS)) {
		const workspace = join(tmpdir(), `bicameral-cap-${id}-${process.pid}`)
		rmSync(workspace, { recursive: true, force: true })
		try {
			prepare(id, workspace, true)
			const before = verify(id, workspace)
			if (before === 0) {
				console.error(`✘ ${id}: fixture already passes; verify is too weak`)
				failed += 1
				continue
			}
			const solution = join(taskDir(id), 'solution')
			if (existsSync(solution)) copyDir(solution, workspace)
			const after = verify(id, workspace)
			if (after !== 0) {
				console.error(`✘ ${id}: solution does not pass`)
				failed += 1
				continue
			}
			console.log(`✔ ${id}: fails before, passes after solution`)
		} finally {
			rmSync(workspace, { recursive: true, force: true })
		}
	}
	if (failed > 0) {
		console.error(`${failed} task(s) failed selftest`)
		process.exit(1)
	}
	console.log('all tasks selftest OK')
}

function report(file) {
	const rows = JSON.parse(readFileSync(resolve(file), 'utf8'))
	if (!Array.isArray(rows)) throw new Error('results file must be a JSON array')
	const byArm = new Map()
	for (const row of rows) {
		const arm = String(row.arm ?? 'unknown')
		const bucket = byArm.get(arm) ?? { arm, runs: 0, pass: 0, ms: 0, tokens: 0, interventions: 0, falseInterventions: 0 }
		bucket.runs += 1
		if (row.pass === true) bucket.pass += 1
		bucket.ms += Number(row.ms) || 0
		bucket.tokens += Number(row.tokens) || 0
		bucket.interventions += Number(row.interventions) || 0
		bucket.falseInterventions += Number(row.falseInterventions) || 0
		byArm.set(arm, bucket)
	}
	console.log(['arm'.padEnd(12), 'runs'.padStart(5), 'pass'.padStart(6), 'rate'.padStart(7), 'avg ms'.padStart(9), 'avg tokens'.padStart(11), 'interv'.padStart(7), 'false'.padStart(6)].join(''))
	for (const bucket of [...byArm.values()].sort((a, b) => a.arm.localeCompare(b.arm))) {
		console.log([
			bucket.arm.padEnd(12),
			String(bucket.runs).padStart(5),
			String(bucket.pass).padStart(6),
			`${((bucket.pass / bucket.runs) * 100).toFixed(1)}%`.padStart(7),
			String(Math.round(bucket.ms / bucket.runs)).padStart(9),
			String(Math.round(bucket.tokens / bucket.runs)).padStart(11),
			String(bucket.interventions).padStart(7),
			String(bucket.falseInterventions).padStart(6),
		].join(''))
	}
	console.log('\nresults are grouped by arm; run each task in a fresh DSH session with a fresh fixture.')
}

const [command, ...args] = process.argv.slice(2)
try {
	if (command === 'list') {
		for (const [id, title] of Object.entries(TASKS)) console.log(`${id.padEnd(20)} ${title}`)
	} else if (command === 'prepare') {
		if (args.length < 2) throw new Error('usage: prepare <task> <workspace> [--force]')
		prepare(args[0], args[1], args.includes('--force'))
	} else if (command === 'verify') {
		if (args.length < 2) throw new Error('usage: verify <task> <workspace>')
		process.exit(verify(args[0], args[1]))
	} else if (command === 'selftest') {
		selftest()
	} else if (command === 'report') {
		if (args.length < 1) throw new Error('usage: report <results.json>')
		report(args[0])
	} else {
		throw new Error('usage: list | prepare | verify | selftest | report')
	}
} catch (error) {
	console.error(`capability: ${error.message}`)
	process.exit(1)
}
