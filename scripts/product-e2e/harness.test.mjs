import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProductE2EHarness, clickByTestId } from './harness.mjs'

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

test('clickByTestId uses a real pointer click on the visible matching element', async () => {
  const hidden = {
    async isVisible() { return false },
  }
  const calls = []
  const visible = {
    async isVisible() { return true },
    async scrollIntoView() { calls.push('scroll') },
    async boundingBox() { return { x: 10, y: 20, width: 100, height: 40 } },
    async evaluate() { return { reachable: true, target: 'BUTTON' } },
    async click() { calls.push('click') },
  }
  const page = {
    async waitForSelector(selector) { calls.push(selector) },
    async $$(selector) {
      calls.push(`all:${selector}`)
      return [hidden, visible]
    },
  }

  await clickByTestId(page, 'target')

  assert.deepEqual(calls, [
    '[data-testid="target"]',
    'all:[data-testid="target"]',
    'scroll',
    'click',
  ])
})

test('system E2E journeys do not bypass browser hit-testing with DOM click', async () => {
  const root = new URL('.', import.meta.url)
  const files = (await readdir(root))
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  const violations = []
  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8')
    source.split('\n').forEach((line, index) => {
      if (/(?:\$eval|\$\$eval|page\.evaluate).*\.click\(\)/u.test(line)) {
        violations.push(`${file}:${index + 1}`)
      }
    })
  }
  assert.deepEqual(violations, [], `DOM-dispatched clicks bypass pointer hit-testing: ${violations.join(', ')}`)
})
