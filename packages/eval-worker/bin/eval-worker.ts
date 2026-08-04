#!/usr/bin/env node
import { cpus, totalmem } from 'node:os'
import { resolve } from 'node:path'

import { EvaluationRunTemplatesSchema, type AgentVariantSpec, type SandboxPolicy } from '@agent-kernel/eval-protocol'
import { ControlPlaneClient, RotatingEd25519Signer, rotatingBearerToken, staticBearerToken } from '@agent-kernel/eval-sdk'
import { readFile } from 'node:fs/promises'

import { EnvironmentCredentialResolver } from '../src/credentials.js'
import { loadWorkerPlugins } from '../src/plugin-loader.js'
import { sanitizeDiagnostic } from '../src/redaction.js'
import { WorkerRuntimeRegistry } from '../src/registry.js'
import { EvaluationWorker } from '../src/worker.js'

const registry = new WorkerRuntimeRegistry()
if (process.argv.includes('--help')) {
  process.stdout.write('usage: agent-eval-worker --plugin <module> --service-id <id> (--token <token>|--token-file <path>) --signing-key-file <path> --key-reference <ref>\n')
  process.exit(0)
}
const plugins = options('--plugin').concat(environmentList('AGENT_EVAL_WORKER_PLUGINS'))
if (plugins.length === 0) throw new Error('at least one --plugin module is required')
await loadWorkerPlugins(plugins, registry)
const capabilities = registry.capabilities()
if (capabilities.sandboxes.length === 0 || capabilities.agents.length === 0 || capabilities.benchmarks.length === 0) {
  throw new Error('Worker plugins must provide at least one sandbox, Agent backend, and benchmark adapter')
}
const readinessTemplatesPath = option('--readiness-templates') ?? process.env.AGENT_EVAL_WORKER_READINESS_TEMPLATES
const readinessPolicies = readinessTemplatesPath ? await loadReadinessPolicies(readinessTemplatesPath) : undefined
const serviceId = required(option('--service-id') ?? process.env.AGENT_EVAL_SERVICE_ID, '--service-id')
const configuredWorkerId = option('--worker-id') ?? process.env.AGENT_EVAL_WORKER_ID
if (configuredWorkerId && configuredWorkerId !== serviceId) throw new Error('--worker-id must match --service-id')
const credentialProvider = controlPlaneCredentials()
const signingKeyFile = resolve(required(option('--signing-key-file') ?? process.env.AGENT_EVAL_SIGNING_KEY_FILE, '--signing-key-file'))
const signingProvider = new RotatingEd25519Signer(required(option('--key-reference') ?? process.env.AGENT_EVAL_KEY_REFERENCE, '--key-reference'), async () => await readFile(signingKeyFile, 'utf8'))
await signingProvider.validate()

const dataDir = resolve(option('--data-dir') ?? process.env.AGENT_EVAL_WORKER_DATA_DIR ?? '.agent-evaluation/worker')
const worker = new EvaluationWorker({
  controlPlane: new ControlPlaneClient({ baseUrl: option('--url') ?? process.env.AGENT_EVAL_URL ?? 'http://127.0.0.1:13100', credentialProvider }),
  registry,
  credentials: new EnvironmentCredentialResolver(),
  workerId: serviceId,
  signingProvider,
  workerVersion: option('--worker-version') ?? process.env.AGENT_EVAL_WORKER_VERSION ?? '0.0.0',
  cpu: positiveNumber(option('--cpu') ?? process.env.AGENT_EVAL_WORKER_CPU ?? String(cpus().length), '--cpu'),
  memoryMb: positiveInteger(option('--memory-mb') ?? process.env.AGENT_EVAL_WORKER_MEMORY_MB ?? String(Math.floor(totalmem() / 1024 / 1024)), '--memory-mb'),
  diskMb: positiveInteger(option('--disk-mb') ?? process.env.AGENT_EVAL_WORKER_DISK_MB ?? '131072', '--disk-mb'),
  gpu: nonnegativeInteger(option('--gpu') ?? process.env.AGENT_EVAL_WORKER_GPU ?? '0', '--gpu'),
  maxTrials: positiveInteger(option('--max-trials') ?? process.env.AGENT_EVAL_WORKER_MAX_TRIALS ?? '1', '--max-trials'),
  leaseMs: positiveInteger(option('--lease-ms') ?? process.env.AGENT_EVAL_WORKER_LEASE_MS ?? '30000', '--lease-ms'),
  artifactRoot: resolve(option('--artifact-root') ?? process.env.AGENT_EVAL_ARTIFACT_ROOT ?? resolve(dataDir, 'artifacts')),
  workerDataDir: dataDir,
  cancellationGraceMs: positiveInteger(option('--cancellation-grace-ms') ?? process.env.AGENT_EVAL_CANCELLATION_GRACE_MS ?? '5000', '--cancellation-grace-ms'),
  onTrialError: (error, trialId) => process.stderr.write('trial ' + trialId + ' failed: ' + safeMessage(error) + '\n'),
  readinessPolicies,
})

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort(new Error(signal)))
process.stderr.write('Agent Evaluation Worker ' + worker.registration.workerId + ' starting with ' + JSON.stringify(capabilities) + '\n')
await worker.start(controller.signal)

function option(name: string): string | undefined { return options(name).at(-1) }
function options(name: string): string[] {
  const values: string[] = []
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[++index]!)
    else if (process.argv[index]?.startsWith(name + '=')) values.push(process.argv[index]!.slice(name.length + 1))
  }
  return values
}
function environmentList(name: string): string[] { return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean) }
function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(name + ' is required'); return value.trim() }
function controlPlaneCredentials() {
  const token = option('--token') ?? process.env.AGENT_EVAL_TOKEN
  const tokenFile = option('--token-file') ?? process.env.AGENT_EVAL_TOKEN_FILE
  if (token && tokenFile) throw new Error('configure exactly one of --token or --token-file')
  if (token) return staticBearerToken(token)
  if (tokenFile) { const path = resolve(tokenFile); return rotatingBearerToken(async () => await readFile(path, 'utf8')) }
  throw new Error('configure exactly one of --token or --token-file')
}
function positiveNumber(value: string, name: string): number { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(name + ' must be positive'); return parsed }
function positiveInteger(value: string, name: string): number { const parsed = positiveNumber(value, name); if (!Number.isInteger(parsed)) throw new Error(name + ' must be an integer'); return parsed }
function nonnegativeInteger(value: string, name: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) throw new Error(name + ' must be a nonnegative integer'); return parsed }
function safeMessage(error: unknown): string { return sanitizeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 500) }

async function loadReadinessPolicies(path: string): Promise<{ sandboxes: readonly SandboxPolicy[]; agents: readonly AgentVariantSpec[] }> {
  const templates = EvaluationRunTemplatesSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')))
  const sandboxes = new Map<string, SandboxPolicy>()
  const agents = new Map<string, AgentVariantSpec>()
  for (const template of templates) {
    const policy = template.spec.sandbox
    const sandboxKey = JSON.stringify([policy.provider, policy.imageDigest, policy.network.mode, policy.network.allowedDestinations])
    sandboxes.set(sandboxKey, policy)
    for (const agent of template.spec.agents) agents.set(agent.backendId + '|' + agent.configHash, agent)
  }
  return { sandboxes: [...sandboxes.values()], agents: [...agents.values()] }
}
