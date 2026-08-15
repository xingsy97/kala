import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveStandaloneData, rollbackStandaloneData } from './standalone-data-migration.mjs'

const roots = []
process.on('exit', () => { for (const root of roots) void rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'standalone-data-migration-')); roots.push(root)
  const legacy = join(root, 'legacy'), target = join(root, 'target')
  await mkdir(join(legacy, '.agent-kernel', 'sessions'), { recursive: true })
  await mkdir(join(legacy, '.claude'), { recursive: true })
  await writeFile(join(legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'session')
  await writeFile(join(legacy, '.claude', 'settings.json'), '{"provider":"safe"}')
  return { root, legacy, target }
}
const noChown = async () => {}

test('atomically moves the state tree without duplicating large Session data', async () => {
  const f = await fixture()
  const receipt = await moveStandaloneData({ sourceRoot: f.legacy, dataRoot: f.target, run: noChown, legacyOwner: 'old', targetOwner: 'new' })
  assert.equal(await readFile(join(f.target, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
  await assert.rejects(readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl')))
  assert.equal(await readFile(join(f.target, '.claude', 'settings.json'), 'utf8'), '{"provider":"safe"}')
  await rollbackStandaloneData(receipt, { run: noChown })
  assert.equal(await readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
})

test('restores the legacy state when post-move ownership fails', async () => {
  const f = await fixture()
  await assert.rejects(moveStandaloneData({ sourceRoot: f.legacy, dataRoot: f.target, run: async () => { throw new Error('injected chown failure') } }), /injected/)
  assert.equal(await readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
  await assert.rejects(readFile(join(f.target, '.agent-kernel', 'sessions', 's.jsonl')))
})
