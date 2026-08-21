import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('evaluation images build orchestrator and dashboard from source', () => {
  for (const name of ['orchestrator', 'dashboard']) {
    const dockerfile = read(`deploy/evaluation/images/Dockerfile.${name}`)
    const dockerignore = read(`deploy/evaluation/images/Dockerfile.${name}.dockerignore`)
    assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/)
    assert.match(dockerfile, /pnpm --filter @agent-kernel\/eval-(orchestrator|dashboard) build/)
    assert.match(dockerfile, /COPY --from=build/)
    assert.doesNotMatch(dockerfile, /COPY packages\/eval-(orchestrator|dashboard)\/dist/)
    assert.match(dockerignore, /!tsconfig\.base\.json/)
    assert.match(dockerignore, new RegExp(`!packages/eval-${name}/\\*\\*`))
  }
})

test('host build is clean and release verification rejects legacy evaluation content', () => {
  const host = JSON.parse(read('packages/host/package.json'))
  assert.match(host.scripts.build, /rmSync\('dist'/)
  const verifier = read('scripts/release/verify-release-assets.mjs')
  assert.match(verifier, /forbiddenLegacyEvaluationMarkers/)
  assert.match(verifier, /src\/eval\//)
})

test('release builders remove native scratch files and verification rejects undeclared files', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  const verifier = read('scripts/release/verify-release-assets.mjs')
  assert.match(builder, /removeNativeBuildWorkspace\(\)/)
  assert.match(builder, /rmSync\(join\(outDir, '\.sea'\), \{ recursive: true, force: true \}\)/)
  assert.match(verifier, /release file set does not exactly match its manifest/)
  assert.match(verifier, /actualReleaseEntries\.some\(\(entry\) => !entry\.isFile\(\)\)/)
})

test('Dashboard release manifest materializes the file iterator before mapping and sorting', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  assert.ok(builder.includes('const files = [...walkFiles(dir)].map'))
  assert.ok(!builder.includes('const files = walkFiles(dir).map'))
})

test('release verification rejects embedded Dashboard assignment without rejecting runtime feature detection', () => {
  const verifier = read('scripts/release/verify-release-assets.mjs')
  assert.ok(verifier.includes("platformRuntime.includes('globalThis.__AGENT_KERNEL_EMBEDDED_DASHBOARD__=')"))
  assert.ok(!verifier.includes("platformRuntime.includes('__AGENT_KERNEL_EMBEDDED_DASHBOARD__')"))
})

test('root tests expose fast and extended aggregation without experiments', () => {
  const root = JSON.parse(read('package.json'))
  assert.equal(root.scripts.test, 'pnpm run test:fast')
  for (const script of ['test:fast', 'test:extended', 'test:workspace', 'test:scripts', 'test:task-packs', 'test:python']) {
    assert.equal(typeof root.scripts[script], 'string')
  }
  assert.match(root.scripts['test:extended'], /test:python/)
  assert.doesNotMatch(root.scripts.test + root.scripts['test:fast'] + root.scripts['test:extended'], /experiments|references/)
})
