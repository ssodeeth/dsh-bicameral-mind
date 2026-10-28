import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.argv[2]
assert.ok(workspace, 'workspace argument required')

for (const file of ['clean.json', 'summary.json']) {
	assert.ok(existsSync(join(workspace, file)), `${file} is missing`)
}

const clean = JSON.parse(readFileSync(join(workspace, 'clean.json'), 'utf8'))
assert.deepEqual(clean, [
	{ id: 1, name: 'Alice', amount: 10.5, date: '2026-01-02' },
	{ id: 6, name: 'Frank', amount: 7.25, date: '2026-01-07' },
	{ id: 7, name: 'Grace', amount: 3.5, date: '2026-01-08' },
])

const summary = JSON.parse(readFileSync(join(workspace, 'summary.json'), 'utf8'))
assert.deepEqual(summary, { total: 3, dropped: 4, totalAmount: 21.25 })

assert.equal(readFileSync(join(workspace, 'data.csv'), 'utf8').split('\n').length, 9, 'data.csv must not be modified')
console.log('verify: ok')
