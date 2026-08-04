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

test('root tests expose fast and extended aggregation without experiments', () => {
  const root = JSON.parse(read('package.json'))
  assert.equal(root.scripts.test, 'pnpm run test:fast')
  for (const script of ['test:fast', 'test:extended', 'test:workspace', 'test:scripts', 'test:task-packs', 'test:python']) {
    assert.equal(typeof root.scripts[script], 'string')
  }
  assert.match(root.scripts['test:extended'], /test:python/)
  assert.doesNotMatch(root.scripts.test + root.scripts['test:fast'] + root.scripts['test:extended'], /experiments|references/)
})
