import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('binds one checksummed asset to the expected release revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'runlab-checksum-index-'))
  try {
    const asset = join(root, 'agent-runlab')
    const index = join(root, 'SHA256SUMS')
    const manifest = join(root, 'manifest.json')
    const revision = 'a'.repeat(40)
    writeFileSync(asset, 'candidate')
    writeFileSync(index, createHash('sha256').update('candidate').digest('hex') + '  agent-runlab\n')
    writeFileSync(manifest, JSON.stringify({ source: { revision }, assets: ['agent-runlab'] }))
    assert.equal(run(['--index', index, '--asset', asset, '--manifest', manifest, '--revision', revision]).status, 0)
    assert.notEqual(run(['--index', index, '--asset', asset, '--manifest', manifest, '--revision', 'b'.repeat(40)]).status, 0)
    writeFileSync(index, read(index) + read(index))
    assert.notEqual(run(['--index', index, '--asset', asset]).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function read(path) { return readFileSync(path, 'utf8') }
function run(args) { return spawnSync(process.execPath, [join(import.meta.dirname, 'verify-checksum-index.mjs'), ...args], { encoding: 'utf8' }) }
