import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildDedicatedSupportBundle, DEDICATED_SUPPORT_ASSETS, DEDICATED_SUPPORT_MANIFEST, extractDedicatedSupportBundle, inspectDedicatedSupportBundle } from './dedicated-support-bundle.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')

test('Dedicated support bundle is deterministic and extracts exactly 14 hash-verified assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'kala-support-test-'))
  try {
    const first = join(root, 'first.tar.gz')
    const second = join(root, 'second.tar.gz')
    const firstResult = buildDedicatedSupportBundle({ root: repositoryRoot, output: first })
    const secondResult = buildDedicatedSupportBundle({ root: repositoryRoot, output: second })
    assert.equal(firstResult.sha256, secondResult.sha256)
    assert.deepEqual(readFileSync(first), readFileSync(second))
    assert.equal(firstResult.manifest.assets.length, 14)
    assert.deepEqual(firstResult.manifest.assets.map((entry) => entry.name), DEDICATED_SUPPORT_ASSETS)

    const extracted = join(root, 'extracted')
    extractDedicatedSupportBundle(first, extracted)
    assert.deepEqual(spawn('find', [extracted, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\n']).trim().split('\n').sort(), [...DEDICATED_SUPPORT_ASSETS].sort())
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Dedicated support verification rejects links, traversal, and extra entries before extraction', () => {
  for (const kind of ['link', 'traversal', 'extra']) {
    const root = mkdtempSync(join(tmpdir(), `kala-support-${kind}-`))
    try {
      const source = join(root, 'source'); mkdirSync(source)
      for (const name of DEDICATED_SUPPORT_ASSETS) writeFileSync(join(source, name), name)
      writeFileSync(join(source, DEDICATED_SUPPORT_MANIFEST), '{}\n')
      const archive = join(root, `${kind}.tar.gz`)
      if (kind === 'link') {
        rmSync(join(source, DEDICATED_SUPPORT_ASSETS[0])); symlinkSync('/etc/passwd', join(source, DEDICATED_SUPPORT_ASSETS[0]))
        spawn('tar', ['-czf', archive, '-C', source, ...DEDICATED_SUPPORT_ASSETS, DEDICATED_SUPPORT_MANIFEST])
      } else if (kind === 'extra') {
        writeFileSync(join(source, 'extra'), 'extra')
        spawn('tar', ['-czf', archive, '-C', source, ...DEDICATED_SUPPORT_ASSETS, DEDICATED_SUPPORT_MANIFEST, 'extra'])
      } else {
        writeFileSync(join(root, 'escape'), 'escape')
        spawn('tar', ['-czf', archive, '--transform=s|escape|../escape|', '-C', root, 'escape'])
      }
      assert.throws(() => inspectDedicatedSupportBundle(archive), /links or special|entries do not exactly match/u)
      assert.equal(spawnSync('test', ['-e', join(root, 'destination')]).status, 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

function spawn(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.status}`)
  return result.stdout
}
