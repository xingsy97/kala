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

test('security, publish, and release workflows fail closed', async () => {
  const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.match(rootPackage.scripts['ci:security'], /verify:supply-chain -- --strict/u)

  const security = await workflow('browser-security.yml')
  for (const scanner of ['SYFT_VERSION', 'GRYPE_VERSION', 'TRIVY_VERSION', 'COSIGN_VERSION']) assert.match(security, new RegExp(`${scanner}: v\\d`, 'u'))
  assert.match(security, /pnpm run ci:security/u)

  const publish = await workflow('publish.yml')
  assert.doesNotMatch(publish, /publish[^\n]*\|\|\s*echo/u)
  assert.match(publish, /scripts\/release\/publish-workspaces\.mjs/u)
  const publisher = await readFile(resolve(root, 'scripts/release/publish-workspaces.mjs'), 'utf8')
  assert.match(publisher, /['view', identity, 'version', '--json']/u)
  assert.match(publisher, /E404|is not in this registry/u)
  assert.match(publisher, /registry lookup failed/u)

  const release = await workflow('release.yml')
  assert.match(release, /gh release create[\s\S]*?--draft/u)
  assert.doesNotMatch(release, /gh release edit "\$TAG" --draft=false/u)
  assert.match(release, /gh release edit "\$TAG" --draft/u)
})

test('Private Cloud release builds signed multi-architecture images and native bundles', async () => {
  const release = await workflow('private-cloud-release.yml')
  for (const dockerfile of ['Dockerfile.runtime-service', 'Dockerfile.runtime-ingress-gateway', 'Dockerfile.dashboard']) assert.match(release, new RegExp(dockerfile.replace('.', '\\.'), 'u'))
  assert.match(release, /platforms: linux\/amd64,linux\/arm64/u)
  assert.match(release, /provenance: mode=max/u)
  assert.match(release, /sbom: true/u)
  assert.match(release, /cosign sign --yes/u)
  assert.match(release, /cosign sign-blob --yes/u)
  assert.match(release, /actions\/attest-build-provenance@v3/u)
  assert.match(release, /linux-x64, linux-arm64/u)
  assert.match(release, /build-private-cloud-bundle\.mjs/u)
  assert.match(release, /verify-private-cloud-bundle\.mjs/u)
  assert.doesNotMatch(release, /--draft=false/u)
})

test('test discovery and release gates cannot silently omit task packs', async () => {
  const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.match(rootPackage.scripts['test:extended'], /test:task-packs/u)
  const scripts = await readFile(resolve(root, 'scripts/testing/run-script-tests.mjs'), 'utf8')
  const taskPacks = await readFile(resolve(root, 'scripts/testing/run-task-pack-tests.mjs'), 'utf8')
  assert.match(scripts, /files\.length === 0/u)
  assert.match(taskPacks, /discovered === 0/u)
  assert.match(taskPacks, /No task-pack tests discovered/u)
})

test('evidence policy binds current records to clean revisions and explicit supersession', async () => {
  const policy = await readFile(resolve(root, 'docs/evidence/README.md'), 'utf8')
  for (const field of ['status', 'sourceRevision', 'generatedAt', 'supersedes', 'generator']) assert.match(policy, new RegExp('`' + field + '`', 'u'))
  const recorder = await readFile(resolve(root, 'scripts/evaluation/record-evidence-revision.mjs'), 'utf8')
  assert.match(recorder, /git', \['status', '--porcelain', '--untracked-files=all'\]/u)
  assert.match(recorder, /refusing to record current evidence from a dirty tree/u)
  assert.match(recorder, /flag: 'wx'/u)
})
