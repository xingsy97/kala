import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./prepare-windows-release-fixture.mjs', import.meta.url))
const sha = (value) => createHash('sha256').update(value).digest('hex')

test('source-built Windows fixture stages matching Host-served assets without claiming release signature', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kala-win-fixture-'))
  const host = join(dir, 'host')
  const executor = join(dir, 'executor')
  try {
    mkdirSync(host); mkdirSync(executor)
    writeFileSync(join(host, 'kala-dashboard-with-runtime.cjs'), 'host')
    writeFileSync(join(host, 'SHA256SUMS'), `${sha('host')}  kala-dashboard-with-runtime.cjs\n`)
    writeFileSync(join(executor, 'kala-executor-win32-x64.exe'), 'executor')
    writeFileSync(join(executor, 'node-pty-win32-x64.tar.gz'), 'conpty')
    const args = [script, '--host-release', host, '--executor-release', executor]
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /not signed release evidence/u)
    const entries = readFileSync(join(host, 'SHA256SUMS'), 'utf8').trim().split('\n')
    assert.equal(entries.length, 4)
    for (const line of entries) {
      const [, digest, name] = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u) ?? []
      assert.ok(name)
      assert.equal(sha(readFileSync(join(host, name))), digest)
    }
    assert.match(readFileSync(join(host, 'install-executor.ps1'), 'utf8'), /win32-x64/u)
    const duplicate = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stderr, /preexisting Windows checksum entry/u)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
