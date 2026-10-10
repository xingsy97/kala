import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const script = join(root, 'scripts/release/version-policy.mjs')

test('release version checks resolve file URLs as native filesystem paths on Windows and POSIX', () => {
  for (const name of ['version-policy.mjs', 'publish-workspaces.mjs']) {
    const source = readFileSync(join(root, 'scripts/release', name), 'utf8')
    assert.match(source, /fileURLToPath\(new URL\('\.\.\/\.\.', import\.meta\.url\)\)/u)
    assert.doesNotMatch(source, /new URL\([^\n]*import\.meta\.url\)\.pathname/u)
  }
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const result = spawnSync(process.execPath, [script, '--tag', `v${version}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS unified product version/u)
})

test('release version policy rejects drift in every Desktop Tauri version source', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'kala-version-policy-'))
  try {
    mkdirSync(join(fixture, 'scripts/release'), { recursive: true })
    for (const dir of ['packages/desktop/src-tauri', 'adapters/agents', 'adapters/benchmarks', 'adapters/environments']) {
      mkdirSync(join(fixture, dir), { recursive: true })
    }
    const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ version: expected }))
    writeFileSync(join(fixture, 'packages/desktop/package.json'), JSON.stringify({ name: 'kala-desktop', version: expected, private: true }))
    writeFileSync(join(fixture, 'scripts/release/version-policy.mjs'), readFileSync(script))
    const sources = {
      'tauri.conf.json': JSON.stringify({ version: expected }),
      'Cargo.toml': `[package]\nname = "kala-desktop"\nversion = "${expected}"\n`,
      'Cargo.lock': `[[package]]\nname = "kala-desktop"\nversion = "${expected}"\n`,
    }
    const path = (name) => join(fixture, 'packages/desktop/src-tauri', name)
    for (const [name, content] of Object.entries(sources)) writeFileSync(path(name), content)
    const run = () => spawnSync(process.execPath, [join(fixture, 'scripts/release/version-policy.mjs')], { encoding: 'utf8' })
    assert.equal(run().status, 0)
    for (const [name, content] of Object.entries(sources)) {
      writeFileSync(path(name), content.replace(expected, '0.3.0-beta.18'))
      const result = run()
      assert.equal(result.status, 1, `${name} drift must fail the release gate`)
      assert.match(result.stderr, /Desktop .* is 0\.3\.0-beta\.18/u)
      writeFileSync(path(name), content)
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
