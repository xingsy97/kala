import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIdentity, cleanupReceipt, loadCanonicalPackInventory } from './benchmark-contracts.mjs'

test('build identity combines package version with an injected commit revision', async () => {
  assert.deepEqual(await buildIdentity({ AGENT_EVAL_BUILD_REVISION: 'c9b86ed39153f0ce57fca905337a55c72aaf2b5e' }), {
    packageVersion: '0.1.10',
    buildRevision: 'c9b86ed39153f0ce57fca905337a55c72aaf2b5e',
    version: '0.1.10+c9b86ed39153',
  })
  await assert.rejects(buildIdentity({}), /AGENT_EVAL_BUILD_REVISION/u)
})

test('canonical inventory covers every supported benchmark pack', async () => {
  const inventory = await loadCanonicalPackInventory()
  assert.deepEqual(inventory.packs.map((pack) => pack.id), ['code-understanding', 'fault-scenarios', 'memory-planning', 'program-bench', 'sdlc-journey', 'swe-bench', 'swe-marathon', 'terminal-bench'])
})

test('cleanup receipt records zero residue only after verified destruction', () => {
  const receipt = cleanupReceipt({ runId: 'run-1', trial: { trialId: 'trial-1', agentVariantId: 'codex', taskId: 'task-1' }, providerRecord: { sandboxId: 'sandbox-1', destroyedAt: '2026-08-05T00:00:00.000Z' } })
  assert.deepEqual(receipt.residue, { instances: 0, networks: 0, acls: 0, volumes: 0, credentialFiles: 0 })
  assert.throws(() => cleanupReceipt({ runId: 'run-1', trial: { trialId: 'trial-1' } }), /verified destruction/u)
})
