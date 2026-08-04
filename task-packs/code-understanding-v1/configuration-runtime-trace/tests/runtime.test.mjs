import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { loadConfig } from '../src/config.mjs'
import { createGreeting } from '../src/runtime.mjs'

test('configured greeting reaches runtime output', async () => {
  const config = await loadConfig()
  assert.equal(createGreeting(config, 'Ada'), 'hello Ada')
  const cli = spawnSync(process.execPath, ['src/cli.mjs', 'Lin'], { encoding: 'utf8' })
  assert.equal(cli.status, 0)
  assert.equal(cli.stdout, 'hello Lin\n')
})
