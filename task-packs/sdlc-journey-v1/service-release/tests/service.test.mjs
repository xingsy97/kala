import assert from 'node:assert/strict'
import test from 'node:test'

import { releaseVersion, responseFor } from '../src/service.mjs'

test('health response stays healthy', () => {
  assert.deepEqual(responseFor('/health'), { status: 200, body: { status: 'ok' } })
})

test('version response exposes the current release', () => {
  assert.equal(releaseVersion, 'v1')
  assert.deepEqual(responseFor('/version'), { status: 200, body: { version: 'v1' } })
})
