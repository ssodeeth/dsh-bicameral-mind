import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workspace = process.argv[2]
assert.ok(workspace, 'workspace argument required')

const tests = spawnSync(process.execPath, ['--test', 'test.mjs'], { cwd: workspace, stdio: 'inherit' })
if (tests.status !== 0) {
	console.error('verify: node:test did not pass')
	process.exit(1)
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
	const path = join(dir, entry.name)
	return entry.isDirectory() ? walk(path) : [path]
})
for (const file of walk(join(workspace, 'src'))) {
	const text = readFileSync(file, 'utf8')
	assert.ok(!text.includes('fetchUser'), `${file} still references fetchUser`)
}
console.log('verify: ok')
