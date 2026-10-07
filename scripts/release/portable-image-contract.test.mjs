import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { inspectPortableAsset, revisionsMatch, versionFromTag } from './verify-portable-container.mjs'

const root = resolve(import.meta.dirname, '../..')

test('accepts a same-revision CJS with an embedded Dashboard', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'portable-image-contract-'))
  try {
    const asset = join(scratch, 'portable.cjs')
    writeFileSync(asset, '#!/usr/bin/env node\n' +
      'globalThis.__KALA_BUILD_INFO__={"releaseTag":"v0.3.0-beta.1","productVersion":"0.3.0-beta.1","gitCommit":"0123456789ab","artifactKind":"cjs","dashboardMode":"embedded"};\n' +
      'globalThis.__KALA_EMBEDDED_DASHBOARD__=[];\n')
    const result = inspectPortableAsset(asset, { tag: 'v0.3.0-beta.1', revision: '0123456789abcdef0123456789abcdef01234567' })
    assert.equal(result.build.dashboardMode, 'embedded')
    assert.match(result.sha256, /^[a-f0-9]{64}$/u)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('rejects stale version, revision, and non-embedded Dashboard metadata', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'portable-image-contract-'))
  try {
    const asset = join(scratch, 'portable.cjs')
    const writeAsset = (overrides = {}) => writeFileSync(asset, '#!/usr/bin/env node\n' +
      `globalThis.__KALA_BUILD_INFO__=${JSON.stringify({ releaseTag: 'v0.3.0-beta.1', productVersion: '0.3.0-beta.1', gitCommit: 'aaaaaaaaaaaa', artifactKind: 'cjs', dashboardMode: 'embedded', ...overrides })};\n` +
      'globalThis.__KALA_EMBEDDED_DASHBOARD__=[];\n')

    writeAsset({ dashboardMode: 'none' })
    assert.throws(() => inspectPortableAsset(asset, { tag: 'v0.3.0-beta.1', revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /embed the Dashboard/u)
    writeAsset({ releaseTag: 'v0.2.0', productVersion: '0.2.0' })
    assert.throws(() => inspectPortableAsset(asset, { tag: 'v0.3.0-beta.1', revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /release tag/u)
    writeAsset()
    assert.throws(() => inspectPortableAsset(asset, { tag: 'v0.3.0-beta.1', revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), /revision/u)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('requires semver tags and permits only unambiguous revision prefixes', () => {
  assert.equal(versionFromTag('v0.3.0-beta.1'), '0.3.0-beta.1')
  assert.throws(() => versionFromTag('latest'), /semantic version/u)
  assert.equal(revisionsMatch('0123456789ab', '0123456789abcdef'), true)
  assert.equal(revisionsMatch('0123456', '0123457'), false)
  assert.equal(revisionsMatch('0123', '0123456789abcdef'), false)
})

test('Dockerfile keeps the release context narrow and declares the runtime safety contract', () => {
  const dockerfile = readFileSync(join(root, 'deploy/portable/Dockerfile'), 'utf8')
  const ignore = readFileSync(join(root, 'deploy/portable/Dockerfile.dockerignore'), 'utf8')
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\}/u)
  assert.match(dockerfile, /COPY --chown=node:node release\/kala-dashboard-with-runtime\.cjs/u)
  assert.match(dockerfile, /USER node\nVOLUME \["\/var\/lib\/kala"\]/u)
  assert.match(dockerfile, /HOME=\/var\/lib\/kala/u)
  assert.match(dockerfile, /KALA_BIND_HOST=0\.0\.0\.0/u)
  assert.match(dockerfile, /sha256sum --check --strict/u)
  assert.equal(ignore.split('\n')[0], '**')
  assert.match(ignore, /!release\/kala-dashboard-with-runtime\.cjs/u)
})
