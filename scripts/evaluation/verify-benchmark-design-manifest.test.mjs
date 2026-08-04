import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)

test('benchmark design manifest statically binds authority, three-Agent subsets, verifiers, and cleanup', async () => {
  const { stdout } = await runFile(process.execPath, ['scripts/evaluation/verify-benchmark-design-manifest.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.deepEqual(JSON.parse(stdout), { ok: true, packs: 8, agents: 3, modelExperimentsRun: 0 })
})
