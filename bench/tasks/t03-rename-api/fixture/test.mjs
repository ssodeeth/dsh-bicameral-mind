import assert from 'node:assert/strict'
import test from 'node:test'

import { getUser } from './src/api.mjs'

test('getUser returns the expected shape', () => {
	assert.deepEqual(getUser(3), { id: 3, name: 'user-3' })
})
