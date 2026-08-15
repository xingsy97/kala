import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const read = async (path) => await readFile(new URL(path, root), 'utf8')

test('slot service shares one logical state root and one write lease', async () => {
  const unit = await read('deploy/standalone-systemd/agent-runlab-unit@.service')
  assert.match(unit, /units\/local\/write\.lock/)
  assert.match(unit, /\.agent-kernel\/sessions/)
  assert.match(unit, /EnvironmentFile=\/etc\/agent-runlab\/slots\/%i\.env/)
  assert.match(unit, /Restart=on-failure/)
})

test('Ingress reads one persistent route authority and Supervisor transfers boot ownership', async () => {
  const ingress = await read('deploy/standalone-systemd/agent-runlab-ingress.service')
  const supervisor = await read('packages/host/bin/agent-runlab-deploy-supervisor.ts')
  assert.match(ingress, /AGENT_RUNLAB_ROUTE_STATE=\/var\/lib\/agent-runlab\/deploy\/route-state\.json/)
  assert.doesNotMatch(supervisor, /active-route\.json/)
  assert.match(supervisor, /systemctl\('enable', '--now', unitService\(slot\)\)/)
  assert.match(supervisor, /systemctl\('disable', '--now', unitService\(slot\)\)/)
})

test('installer fails closed on old Node and records explicit container backend policy', async () => {
  const installer = await read('scripts/deploy/install-standalone-systemd.mjs')
  assert.match(installer, /Node\.js 22\+ is required/)
  assert.match(installer, /AGENT_RUNLAB_CONTAINER_BACKEND/)
  assert.match(installer, /containerBackend/)
  assert.match(installer, /runuser.*agent-runlab.*docker.*info/s)
  const cutover = await read('scripts/deploy/cutover-standalone-systemd.mjs')
  const migration = await read('scripts/deploy/standalone-data-migration.mjs')
  assert.match(cutover, /sanitised provider\/model settings fingerprint changed during migration/)
  assert.match(cutover, /moveStandaloneData/)
  assert.match(cutover, /rollbackStandaloneData/)
  assert.match(migration, /\.claude\/settings\.json/)
  assert.match(migration, /\.config\/agent-kernel\/models\.json/)
})
