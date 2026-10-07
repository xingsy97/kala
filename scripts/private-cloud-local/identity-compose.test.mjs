import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const compose = resolve(import.meta.dirname, '../../deploy/identity/compose.yaml')

test('identity Compose percent-encodes reserved characters in a generated Postgres password', () => {
  const source = readFileSync(compose, 'utf8')
  const line = source.match(/^        password_uri=(.+)$/mu)?.[1]
  assert.ok(line, 'identity config must encode the Postgres secret before putting it in a URL')
  const dir = mkdtempSync(join(tmpdir(), 'kala-identity-dsn-'))
  try {
    const password = 'a/b+c:with@reserved?chars#here%'
    const secret = join(dir, 'postgres_password')
    writeFileSync(secret, `${password}\n`, { mode: 0o600 })
    const command = `password_uri=${line.replaceAll('$$', '$').replace('/run/secrets/postgres_password', secret)}`
    const encoded = execFileSync('sh', ['-ec', `${command}\nprintf '%s' "$password_uri"`], { encoding: 'utf8' })
    const dsn = new URL(`postgresql://zitadel:${encoded}@postgres:5432/zitadel?sslmode=disable`)
    assert.equal(dsn.hostname, 'postgres')
    assert.equal(decodeURIComponent(dsn.password), password)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
