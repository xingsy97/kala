import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

test('accepts arbitrary names and rejects invalid arity', () => {
  for (const name of ['Ada', 'two words', 'Ω']) {
    const result = spawnSync(process.execPath, [entry, name], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, `hello ${name}\n`)
  }
  const invalid = spawnSync(process.execPath, [entry], { encoding: 'utf8' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /usage:/u)
})
