import assert from 'node:assert/strict'
import test from 'node:test'

import { average, median, sum } from './math.mjs'

test('sum adds numbers', () => {
	assert.equal(sum([1, 2, 3]), 6)
	assert.equal(sum([]), 0)
})

test('average of an empty list is 0', () => {
	assert.equal(average([]), 0)
	assert.equal(average([2, 4]), 3)
})

test('median handles odd and even lengths', () => {
	assert.equal(median([3, 1, 2]), 2)
	assert.equal(median([4, 1, 3, 2]), 2.5)
	assert.equal(median([]), 0)
})
