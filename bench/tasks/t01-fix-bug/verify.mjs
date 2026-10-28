import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workspace = process.argv[2]
assert.ok(workspace, 'workspace argument required')

const tests = spawnSync(process.execPath, ['--test', 'math.test.mjs'], { cwd: workspace, stdio: 'inherit' })
if (tests.status !== 0) {
	console.error('verify: node:test did not pass')
	process.exit(1)
}

const source = readFileSync(join(workspace, 'math.mjs'), 'utf8')
assert.match(source, /export\s+function\s+median/, 'math.mjs must export median')
assert.match(source, /export\s+function\s+average/, 'math.mjs must export average')
assert.match(source, /export\s+function\s+sum/, 'math.mjs must export sum')
console.log('verify: ok')
