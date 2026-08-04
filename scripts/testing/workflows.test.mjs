import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const workflow = async (name) => await readFile(resolve(root, '.github/workflows', name), 'utf8')

const automaticEvents = (source) => source.match(/^on:\n([\s\S]*?)\n(?:permissions|concurrency|jobs):/mu)?.[1] ?? ''

test('PR workflow contains only fast typecheck, unit, boundary, and static gates', async () => {
  const source = await workflow('ci.yml')
  assert.match(source, /pull_request:/u)
  assert.match(source, /pnpm run ci:fast/u)
  for (const expensive of ['ci:browser', 'ci:sandbox-acceptance', 'ci:release-acceptance', 'evaluation:run-real']) assert.doesNotMatch(source, new RegExp(expensive, 'u'))
})

test('integration, browser/security, and container acceptance are separate layers', async () => {
  assert.match(await workflow('integration.yml'), /ci:integration/u)
  const browserSecurity = await workflow('browser-security.yml')
  assert.match(browserSecurity, /layer: \[browser, security\]/u)
  const acceptance = await workflow('container-acceptance.yml')
  assert.match(acceptance, /layer: \[sandbox-acceptance, release-acceptance\]/u)
  assert.doesNotMatch(automaticEvents(acceptance), /pull_request:/u)
})

test('real model and benchmark subset workflow is manual or scheduled and containerized', async () => {
  const source = await workflow('real-model-evaluation.yml')
  const events = automaticEvents(source)
  assert.match(events, /workflow_dispatch:/u)
  assert.match(events, /schedule:/u)
  assert.doesNotMatch(events, /(?:pull_request|push):/u)
  assert.match(source, /^    container:\n      image: /mu)
  assert.match(source, /evaluation:run-real-task-pack/u)
  assert.match(source, /evaluation:run-real-swe-bench/u)
})

test('verification fixtures use ephemeral scoped auth without anonymous fallback', async () => {
  const fixture = await readFile(resolve(root, 'scripts/evaluation/fixtures/ephemeral-auth.mjs'), 'utf8')
  assert.match(fixture, /randomBytes/u)
  assert.match(fixture, /BearerTokenAuthenticator/u)
  for (const role of ['operator', 'worker', 'analyzer']) assert.match(fixture, new RegExp("'" + role + "'", 'u'))
  for (const name of ['run-real-task-pack.mjs', 'run-real-swe-bench.mjs', 'verify-remaining-benchmark-lifecycles.mjs']) {
    const source = await readFile(resolve(root, 'scripts/evaluation', name), 'utf8')
    assert.match(source, /createEphemeralAuth/u)
    assert.match(source, /createEvaluationHttpServer\(controlPlane, \{ authenticator: auth\.authenticator \}\)/u)
    assert.doesNotMatch(source, /createEvaluationHttpServer\(controlPlane\)\s*$/mu)
  }
})
