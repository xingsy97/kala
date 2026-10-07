import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
