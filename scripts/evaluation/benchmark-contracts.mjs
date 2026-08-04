import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..')

export async function loadCanonicalPackInventory() {
  const inventory = JSON.parse(await readFile(resolve(root, 'docs/evaluation/canonical-pack-inventory.json'), 'utf8'))
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.packs)) throw new Error('invalid canonical pack inventory')
  const ids = inventory.packs.map((pack) => pack.id)
  if (new Set(ids).size !== ids.length) throw new Error('canonical pack inventory contains duplicate IDs')
  return inventory
}

export async function buildIdentity(environment = process.env) {
  const packageMetadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const packageVersion = environment.AGENT_EVAL_PACKAGE_VERSION?.trim() || packageMetadata.version
  const buildRevision = environment.AGENT_EVAL_BUILD_REVISION?.trim()
  if (!packageVersion || packageVersion === '0.0.0') throw new Error('set a non-placeholder package version')
  if (!buildRevision || !/^[0-9a-f]{7,64}$/iu.test(buildRevision)) throw new Error('AGENT_EVAL_BUILD_REVISION must be an explicit commit revision')
  return { packageVersion, buildRevision, version: packageVersion + '+' + buildRevision.slice(0, 12) }
}

export function cleanupReceipt({ runId, trial, providerRecord }) {
  if (!providerRecord?.destroyedAt) throw new Error('cleanup receipt requires verified destruction for ' + trial.trialId)
  return {
    schemaVersion: 1,
    runId,
    trialId: trial.trialId,
    agentVariantId: trial.agentVariantId,
    taskId: trial.taskId,
    provider: 'lxd-container',
    sandboxId: providerRecord.sandboxId,
    destroyedAt: providerRecord.destroyedAt,
    residue: { instances: 0, networks: 0, acls: 0, volumes: 0, credentialFiles: 0 },
  }
}
