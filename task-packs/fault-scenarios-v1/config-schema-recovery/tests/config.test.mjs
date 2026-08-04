import assert from 'node:assert/strict'
import test from 'node:test'

import { parseServiceConfig } from '../src/config.mjs'

test('accepts a valid service configuration', () => {
  assert.deepEqual(parseServiceConfig('{"port":18110,"greeting":"ready"}'), { port: 18110, greeting: 'ready' })
})

test('rejects a string-valued port instead of coercing it', () => {
  assert.throws(() => parseServiceConfig('{"port":"18110","greeting":"ready"}'), /CONFIG_SCHEMA_INVALID/u)
})
