import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('submission exposes an executable source file', () => {
  const result = spawnSync(process.execPath, ['program.mjs', 'public'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'hello public\n')
})
