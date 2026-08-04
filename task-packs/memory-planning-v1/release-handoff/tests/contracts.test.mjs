import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { stepDefinitions } from '../scripts/run-step.mjs'

test('plan graph has six steps, a parallel branch, and one terminal verifier', () => {
  assert.deepEqual(Object.keys(stepDefinitions), ['recall', 'update', 'test', 'policy', 'package', 'verify'])
  assert.deepEqual(stepDefinitions.test, ['update'])
  assert.deepEqual(stepDefinitions.policy, ['update'])
  assert.deepEqual(stepDefinitions.package, ['test', 'policy'])
  assert.deepEqual(stepDefinitions.verify, ['package'])
})
