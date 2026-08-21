import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeDedicatedDataMigration, moveDedicatedData, planDedicatedDataMigration, probeDedicatedAtomicRename, rollbackDedicatedData } from './dedicated-data-migration.mjs'

const roots = []
process.on('exit', () => { for (const root of roots) void rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dedicated-data-migration-')); roots.push(root)
  const legacy = join(root, 'legacy'), target = join(root, 'target')
  await mkdir(join(legacy, '.agent-kernel', 'sessions'), { recursive: true })
  await mkdir(join(legacy, '.claude'), { recursive: true })
  await mkdir(join(legacy, '.codex'), { recursive: true })
  await mkdir(join(legacy, '.config', 'agent-kernel'), { recursive: true })
  await writeFile(join(legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'session')
  await writeFile(join(legacy, '.claude', 'settings.json'), '{"provider":"safe"}')
  await writeFile(join(legacy, '.codex', 'config.toml'), 'model = "safe"')
  await writeFile(join(legacy, '.codex', 'auth.json'), '{"auth":"safe"}')
  await writeFile(join(legacy, '.config', 'agent-kernel', 'models.json'), '{"defaultModel":"safe"}')
  await writeFile(join(legacy, '.config', 'agent-kernel', 'agent.json'), '{"systemPromptPreset":"codex"}')
  await writeFile(join(legacy, '.config', 'agent-kernel', 'config.toml'), '[[hooks]]\nevent = "session_start"\ncommand = "true"')
  await writeFile(join(legacy, '.config', 'agent-kernel', 'socket-admin.json'), '{"schemaVersion":1}')
  return { root, legacy, target }
}
const noChown = async () => {}

test('atomically moves the state tree without duplicating large Session data', async () => {
  const f = await fixture()
  const receipt = await moveDedicatedData({ sourceRoot: f.legacy, dataRoot: f.target, run: noChown, legacyOwner: 'old', targetOwner: 'new' })
  assert.equal(await readFile(join(f.target, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
  await assert.rejects(readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl')))
  assert.equal(await readFile(join(f.target, '.claude', 'settings.json'), 'utf8'), '{"provider":"safe"}')
  assert.equal(await readFile(join(f.target, '.codex', 'config.toml'), 'utf8'), 'model = "safe"')
  assert.equal(await readFile(join(f.target, '.codex', 'auth.json'), 'utf8'), '{"auth":"safe"}')
  assert.equal(await readFile(join(f.target, '.config', 'agent-kernel', 'agent.json'), 'utf8'), '{"systemPromptPreset":"codex"}')
  assert.equal(await readFile(join(f.target, '.config', 'agent-kernel', 'config.toml'), 'utf8'), '[[hooks]]\nevent = "session_start"\ncommand = "true"')
  assert.equal(await readFile(join(f.target, '.config', 'agent-kernel', 'socket-admin.json'), 'utf8'), '{"schemaVersion":1}')
  await rollbackDedicatedData(receipt, { run: noChown })
  assert.equal(await readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
})

test('probes atomic rename in the caller mount namespace without moving state', async () => {
  const f = await fixture()
  await probeDedicatedAtomicRename({ sourceRoot: f.legacy, dataRoot: f.target })
  assert.equal(await readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
  await assert.rejects(readFile(join(f.target, '.agent-kernel', 'sessions', 's.jsonl')))
})

test('restores the legacy state when post-move ownership fails', async () => {
  const f = await fixture()
  let calls = 0
  await assert.rejects(moveDedicatedData({ sourceRoot: f.legacy, dataRoot: f.target, run: async () => { if (calls++ === 0) throw new Error('injected chown failure') } }), /injected/)
  assert.equal(await readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
  await assert.rejects(readFile(join(f.target, '.agent-kernel', 'sessions', 's.jsonl')))
})

test('resumes after a crash immediately following the atomic state rename', async () => {
  const f = await fixture()
  const migration = await planDedicatedDataMigration({ sourceRoot: f.legacy, dataRoot: f.target, legacyOwner: 'old', targetOwner: 'new' })
  await rename(migration.sourceState, migration.targetState)
  await executeDedicatedDataMigration(migration, { run: noChown })
  await executeDedicatedDataMigration(migration, { run: noChown })
  assert.equal(await readFile(join(f.target, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
  assert.equal(await readFile(join(f.target, '.claude', 'settings.json'), 'utf8'), '{"provider":"safe"}')
  await rollbackDedicatedData(migration, { run: noChown })
  await rollbackDedicatedData(migration, { run: noChown })
  assert.equal(await readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
})

test('fails closed when both source and target state roots exist', async () => {
  const f = await fixture()
  const migration = await planDedicatedDataMigration({ sourceRoot: f.legacy, dataRoot: f.target, legacyOwner: 'old', targetOwner: 'new' })
  await mkdir(migration.targetState, { recursive: true })
  await assert.rejects(executeDedicatedDataMigration(migration, { run: noChown }), /both legacy and migrated/)
  await assert.rejects(rollbackDedicatedData(migration, { run: noChown }), /both legacy and migrated/)
})

test('fences home configuration that changes after migration planning', async () => {
  const f = await fixture()
  const migration = await planDedicatedDataMigration({ sourceRoot: f.legacy, dataRoot: f.target, legacyOwner: 'old', targetOwner: 'new' })
  await writeFile(join(f.legacy, '.config', 'agent-kernel', 'agent.json'), '{"systemPromptPreset":"changed"}')
  await assert.rejects(executeDedicatedDataMigration(migration, { run: noChown }), /home config changed/)
  await rollbackDedicatedData(migration, { run: noChown })
  assert.equal(await readFile(join(f.legacy, '.agent-kernel', 'sessions', 's.jsonl'), 'utf8'), 'session')
})
