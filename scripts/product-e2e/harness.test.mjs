import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProductE2EHarness } from './harness.mjs'

test('records task evidence and cleans resources in reverse order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-e2e-harness-'))
  const harness = new ProductE2EHarness({ evidenceRoot: root })
  const cleanupOrder = []
  harness.registerResource('session', 'a', async () => cleanupOrder.push('a'))
  harness.registerResource('workspace', 'b', async () => cleanupOrder.push('b'))
  await harness.step('persist side effect', async () => ({ id: 'side-effect' }), (value) => ({ persistedId: value.id }))
  const { report, reportPath } = await harness.finalize({ revision: 'test' })
  assert.deepEqual(cleanupOrder, ['b', 'a'])
  assert.equal(report.steps[0].evidence.persistedId, 'side-effect')
  assert.equal(report.cleanup.every((entry) => entry.ok), true)
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).revision, 'test')
})

test('assertClean rejects HTTP, console, page, and cleanup failures', () => {
  const harness = new ProductE2EHarness()
  assert.throws(() => harness.assertClean({
    actors: [{ name: 'mobile', failedResponses: [{ status: 500, url: 'http://test/api' }], consoleErrors: [], pageErrors: [] }],
    failures: [],
  }), /HTTP 500/u)
})
