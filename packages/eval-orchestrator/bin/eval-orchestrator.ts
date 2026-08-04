#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { EvaluationRunTemplatesSchema } from '@agent-kernel/eval-protocol'

import { EvaluationControlPlane } from '../src/control-plane.js'
import { createEvaluationHttpServer } from '../src/http-server.js'
import { RegisteredTaskCatalog } from '../src/task-catalog.js'
import { FileBackedSecurityRegistry } from '../src/security-registry.js'
import { EvidenceArchive } from '../src/evidence-archive.js'
import { readMaintenanceStatus } from '../src/maintenance.js'

const host = option('--host') ?? process.env.AGENT_EVAL_HOST ?? '127.0.0.1'
const port = positiveInteger(option('--port') ?? process.env.AGENT_EVAL_PORT ?? '13100', '--port')
const dataDir = resolve(option('--data-dir') ?? process.env.AGENT_EVAL_DATA_DIR ?? '.agent-evaluation')
const catalogPath = option('--catalog') ?? process.env.AGENT_EVAL_TASK_CATALOG
const evidencePath = option('--evidence-dir') ?? process.env.AGENT_EVAL_EVIDENCE_DIR
const runTemplatesPath = option('--run-templates') ?? process.env.AGENT_EVAL_RUN_TEMPLATES
const authConfigPath = option('--auth-config') ?? process.env.AGENT_EVAL_AUTH_CONFIG
const trustConfigPath = option('--trust-config') ?? process.env.AGENT_EVAL_TRUST_CONFIG
if (!authConfigPath) throw new Error('--auth-config or AGENT_EVAL_AUTH_CONFIG is required; anonymous API access is disabled')

const catalog = new RegisteredTaskCatalog()
if (catalogPath) {
  const entries = JSON.parse(await readFile(resolve(catalogPath), 'utf8')) as Array<{ sliceManifestHash?: unknown; tasks?: unknown }>
  if (!Array.isArray(entries)) throw new Error('task catalog must be an array')
  for (const entry of entries) {
    if (typeof entry.sliceManifestHash !== 'string' || !Array.isArray(entry.tasks)) throw new Error('invalid task catalog entry')
    catalog.register(entry.sliceManifestHash, entry.tasks as never[])
  }
}

const runTemplates = EvaluationRunTemplatesSchema.parse(runTemplatesPath ? JSON.parse(await readFile(resolve(runTemplatesPath), 'utf8')) : [])
const security = new FileBackedSecurityRegistry(resolve(authConfigPath), trustConfigPath ? resolve(trustConfigPath) : undefined)
await security.initialize()
const controlPlane = new EvaluationControlPlane({ journalPath: resolve(dataDir, 'control-plane.jsonl'), reportRoot: resolve(dataDir, 'artifacts'), taskCatalog: catalog, evidenceArchive: new EvidenceArchive(evidencePath ? resolve(evidencePath) : undefined), runTemplates, signingKeyRegistry: security })
await controlPlane.initialize()
const server = createEvaluationHttpServer(controlPlane, { authenticator: security, administration: { securityMetadata: () => security.metadata(), reloadSecurity: async (actorId) => await security.reload(actorId), maintenanceStatus: async () => await readMaintenanceStatus(dataDir) } })
process.on('SIGHUP', () => { void security.reload('signal:SIGHUP').catch((error: unknown) => process.stderr.write('Security registry reload failed: ' + (error instanceof Error ? error.message : String(error)) + '\n')) })
server.listen(port, host, () => process.stderr.write('Agent Evaluation Control Plane listening on http://' + host + ':' + String(port) + '\n'))

function option(name: string): string | undefined {
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) return process.argv[index + 1]
    if (process.argv[index]?.startsWith(name + '=')) return process.argv[index]!.slice(name.length + 1)
  }
  return undefined
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(name + ' must be a positive integer')
  return parsed
}
