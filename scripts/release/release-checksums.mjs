import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Verify the entire exact release index on every platform, including Windows
// runners that do not provide Perl's shasum executable.
export async function verifyReleaseChecksums(directory, expectedFiles) {
  const expected = new Set(expectedFiles)
  if (expected.size !== expectedFiles.length) throw new Error('duplicate expected release file')
  const lines = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trimEnd().split(/\r?\n/u)
  if (lines.length !== expected.size) throw new Error('checksum index must cover every release file exactly once')
  const seen = new Set()
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u)
    if (!match || !expected.has(match[2]) || seen.has(match[2])) throw new Error('invalid or duplicate release checksum entry')
    seen.add(match[2])
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(directory, match[2]))) hash.update(chunk)
    if (hash.digest('hex') !== match[1]) throw new Error('release file checksum mismatch')
  }
}
