import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('README presents Kala as the public project and installer repository', () => {
  const readme = read('README.md')
  assert.match(readme, /^# Kala$/m)
  assert.match(readme, /github\.com\/xingsy97\/kala\/releases\/latest\/download\/run\.sh/)
  assert.match(readme, /KALA_PROVIDER=openai/)
  assert.doesNotMatch(readme, /akernel|@agent-kernel|AGENT_KERNEL_PROVIDER/i)
})

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

test('both full and native-only SEA Executor builds resolve adjacent native addons', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  assert.match(builder, /const wantsNativeBuild = !finalizeOnly && \(nativeOnly \|\| !noNative\)/)
  assert.match(builder, /const nativeRequire = wantsNativeBuild && item\.name === 'agent-kernel-executor'/)
  assert.match(builder, /createRequire\(__filename\)/)
  assert.match(builder, /\$\{nativeRequire\}\$\{buildInfo\}/)
})

test('release docs include tracked files only and exclude the unfinished showcase', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  assert.match(builder, /spawnSync\('git', \['ls-files', '-z', '--', 'docs\/']/)
  assert.match(builder, /file !== 'docs\/assets\/kala-dashboard-preview\.gif'/)
  assert.match(builder, /'--null', '-T', '-'/)
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

test('release scripts enforce Linux and macOS assets and reject Windows offers', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  const verifier = read('scripts/release/verify-release-assets.mjs')
  const installSmoke = read('scripts/release/verify-release-install.mjs')
  assert.match(builder, /Windows release assets are not included in this release/)
  assert.doesNotMatch(builder, /install-executor\.ps1|node-pty-win32|writeExecutorUpdateManifest/)
  assert.match(verifier, /supportedNativeTargets = \['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'\]/)
  assert.match(verifier, /assertSupportedReleaseAssetName\(asset\?\.path, 'embedded Host assets'\)/)
  assert.match(verifier, /executor-update-/)
  for (const forbidden of ['install-executor.ps1', 'node-pty-win32-x64.tar.gz', 'node-pty-win32-arm64.tar.gz', 'executor-update-manifest.json']) {
    assert.match(installSmoke, new RegExp(forbidden.replaceAll('.', '\\.')))
  }
  assert.match(installSmoke, /expected unsupported or platform-ambiguous asset to be absent/)
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
