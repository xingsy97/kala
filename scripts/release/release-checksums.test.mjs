import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyReleaseChecksums } from './release-checksums.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('verifies each release byte once with LF or Windows CRLF indexes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kala-release-hashes-'))
  try {
    writeFileSync(join(directory, 'asset.bin'), Buffer.from([0, 1, 2, 255]))
    writeFileSync(join(directory, 'manifest.json'), '{}\n')
    const entries = [`${digest(Buffer.from([0, 1, 2, 255]))}  asset.bin`, `${digest('{}\n')}  manifest.json`]
    for (const newline of ['\n', '\r\n']) {
      writeFileSync(join(directory, 'SHA256SUMS'), entries.join(newline) + newline)
      await verifyReleaseChecksums(directory, ['asset.bin', 'manifest.json'])
    }
    writeFileSync(join(directory, 'asset.bin'), Buffer.from([0, 1, 3, 255]))
    await assert.rejects(verifyReleaseChecksums(directory, ['asset.bin', 'manifest.json']), /checksum mismatch/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('rejects missing, duplicated, wrong-file and malformed checksum entries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kala-release-index-'))
  try {
    writeFileSync(join(directory, 'asset.bin'), 'safe')
    writeFileSync(join(directory, 'manifest.json'), '{}\n')
    const assetLine = `${digest('safe')}  asset.bin`
    for (const index of [
      assetLine + '\n',
      `${assetLine}\n${assetLine}\n`,
      `${assetLine}\n${digest('{}\n')}  unrelated.json\n`,
      `${assetLine}\n${digest('{}\n')} manifest.json\n`,
    ]) {
      writeFileSync(join(directory, 'SHA256SUMS'), index)
      await assert.rejects(verifyReleaseChecksums(directory, ['asset.bin', 'manifest.json']))
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
