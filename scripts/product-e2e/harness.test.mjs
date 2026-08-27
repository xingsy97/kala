import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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

test('coverage ledger accounts for every normative critical user journey', async () => {
  const docs = new URL('../../docs/testing/', import.meta.url)
  const matrix = await readFile(new URL('critical-user-action-matrix.md', docs), 'utf8')
  const ledger = await readFile(new URL('system-e2e-coverage-ledger.md', docs), 'utf8')
  const mappings = new Map([
    ['Private Cloud::Register/sign in', ['Private Cloud identity/isolation']],
    ['Private Cloud::Sign out', ['Private Cloud identity/isolation']],
    ['Platform::Account/settings entry', ['Account/settings entry']],
    ['Platform::Add Workspace', ['Add Workspace — Linux service']],
    ['Platform::New Workspace Session', ['New Session']],
    ['Platform::Select Agent Runtime', ['Agent Runtime selection']],
    ['Platform::Send direct message', ['Direct message']],
    ['Platform::Queue message', ['Queue message']],
    ['Platform::File', ['Files and preview']],
    ['Platform::Git', ['Git']],
    ['Platform::Shell', ['Interactive Terminal', 'Background Shell registry']],
    ['Platform::Artifact preview', ['Artifact preview']],
    ['Platform::Agent tool chain', ['Agent tool chain']],
    ['Platform::Copilot Runtime journey', ['GitHub Copilot Runtime']],
    ['Platform::Sub-agent', ['Sub-agent lifecycle']],
    ['Platform::Streaming scroll', ['Streaming scroll']],
    ['Platform::Notifications', ['Notifications']],
    ['Platform::PWA', ['PWA install/update/offline']],
    ['Dedicated::Benchmark/Evaluation', ['Dedicated benchmark/evaluation']],
    ['Private Cloud::Benchmark/Evaluation', ['Private Cloud benchmark denial']],
    ['Platform::Responsive surfaces', ['Responsive surfaces']],
  ])
  const entries = [...matrix.matchAll(/^\| (Platform|Dedicated|Private Cloud) \| ([^|]+?) \|/gmu)]
    .map((match) => `${match[1]}::${match[2].trim()}`)
  const missingMappings = entries.filter((entry) => !mappings.has(entry))
  assert.deepEqual(missingMappings, [], `matrix entries without ledger mapping: ${missingMappings.join(', ')}`)
  for (const [entry, ledgerJourneys] of mappings) {
    for (const ledgerJourney of ledgerJourneys) {
      assert.match(ledger, new RegExp(`\\\\| ${escapeRegex(ledgerJourney)} `, 'u'), `${entry} is missing ${ledgerJourney} from the coverage ledger`)
    }
  }
})

test('complete coverage claims cite production system E2E scripts', async () => {
  const ledger = await readFile(new URL('../../docs/testing/system-e2e-coverage-ledger.md', import.meta.url), 'utf8')
  const completeRows = ledger.split('\n')
    .filter((line) => line.startsWith('| ') && /\| Complete(?: \(| \|)/u.test(line))
  const violations = completeRows
    .filter((line) => !line.includes('`scripts/product-e2e/'))
    .map((line) => line.split('|')[1].trim())

  assert.deepEqual(violations, [], `Complete claims without production system E2E evidence: ${violations.join(', ')}`)
})

test('persists the final report when cleanup removes the evidence directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-e2e-harness-cleanup-'))
  const harness = new ProductE2EHarness({ evidenceRoot: root })
  harness.registerResource('temporary-root', root, async () => rm(root, { recursive: true, force: true }))

  const { reportPath } = await harness.finalize()

  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).name, 'product-e2e')
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

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
      if (/\.click\(\)/u.test(line) && !(file === 'harness.mjs' && line.includes('await element.click()'))) {
        violations.push(`${file}:${index + 1}`)
      }
    })
  }
  assert.deepEqual(violations, [], `DOM-dispatched clicks bypass pointer hit-testing: ${violations.join(', ')}`)
})
