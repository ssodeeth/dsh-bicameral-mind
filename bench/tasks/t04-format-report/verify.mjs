import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.argv[2]
assert.ok(workspace, 'workspace argument required')
const file = join(workspace, 'report.md')
assert.ok(existsSync(file), 'report.md is missing')
const text = readFileSync(file, 'utf8')
const lines = text.split(/\r?\n/)

assert.equal(lines[0].trim(), '# Status Report', 'first line must be the title')
const summaryIndex = lines.findIndex((line) => line.trim() === '## Summary')
const findingsIndex = lines.findIndex((line) => line.trim() === '## Findings')
const nextIndex = lines.findIndex((line) => line.trim() === '## Next steps')
assert.ok(summaryIndex > 0 && findingsIndex > summaryIndex && nextIndex > findingsIndex, 'section order is wrong')

const h1 = lines.filter((line) => /^#\s/.test(line.trim()))
assert.equal(h1.length, 1, 'exactly one level-1 title is allowed')
const h2 = lines.filter((line) => /^##\s/.test(line.trim()))
assert.deepEqual(h2.map((line) => line.trim()), ['## Summary', '## Findings', '## Next steps'], 'unexpected level-2 sections')

const summary = lines.slice(summaryIndex + 1, findingsIndex).join(' ')
const findings = lines.slice(findingsIndex + 1, nextIndex).filter((line) => line.trim().startsWith('- '))
const next = lines.slice(nextIndex + 1).filter((line) => line.trim().startsWith('- '))
assert.ok(/latency/i.test(summary), 'Summary must mention latency')
assert.ok(findings.length >= 3, 'Findings needs at least 3 bullets')
assert.ok(findings.some((line) => /retry/i.test(line)) && findings.some((line) => /alert/i.test(line)), 'Findings must mention retry and alert')
assert.ok(next.length >= 2, 'Next steps needs at least 2 bullets')
assert.ok(next.some((line) => /p99/i.test(line)) && next.some((line) => /runbook/i.test(line)), 'Next steps must mention p99 and runbook')

const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word))
assert.ok(words.length >= 120 && words.length <= 220, `word count must be 120-220, got ${words.length}`)
console.log('verify: ok')
