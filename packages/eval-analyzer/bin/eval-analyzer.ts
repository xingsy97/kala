#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

import { ControlPlaneClient, RotatingEd25519Signer, rotatingBearerToken, staticBearerToken } from '@agent-kernel/eval-sdk'
import { EvaluationGrader } from '../src/grader-runner.js'
import { loadDetectorPlugins } from '../src/detector-plugins.js'
import { EvaluationAnalyzer } from '../src/runner.js'
import { CommandCounterfactualContinuationHarness } from '../src/counterfactual.js'

const baseUrl = option('--url') ?? process.env.AGENT_EVAL_URL ?? 'http://127.0.0.1:13100'
const executorId = required(option('--service-id') ?? process.env.AGENT_EVAL_SERVICE_ID, '--service-id')
const configuredExecutorId = option('--executor-id') ?? process.env.AGENT_EVAL_ANALYZER_ID
if (configuredExecutorId && configuredExecutorId !== executorId) throw new Error('--executor-id must match --service-id')
const leaseMs = integer(option('--lease-ms') ?? process.env.AGENT_EVAL_ANALYZER_LEASE_MS ?? '30000')
const controlPlane = new ControlPlaneClient({ baseUrl, credentialProvider: controlPlaneCredentials() })
const signingKeyFile = resolve(required(option('--signing-key-file') ?? process.env.AGENT_EVAL_SIGNING_KEY_FILE, '--signing-key-file'))
const reproductionSigningProvider = new RotatingEd25519Signer(required(option('--key-reference') ?? process.env.AGENT_EVAL_KEY_REFERENCE, '--key-reference'), async () => await readFile(signingKeyFile, 'utf8'))
await reproductionSigningProvider.validate()
const detectorPlugins = await loadDetectorPlugins(options('--plugin').concat(environmentList('AGENT_EVAL_ANALYZER_PLUGINS')))
const counterfactualCommand = option('--counterfactual-command') ?? process.env.AGENT_EVAL_COUNTERFACTUAL_COMMAND
const analyzer = new EvaluationAnalyzer({
  controlPlane, executorId, leaseMs, detectorPlugins, reproductionSigningProvider,
  ...(counterfactualCommand ? { counterfactualHarness: new CommandCounterfactualContinuationHarness(['/bin/sh', '-c', counterfactualCommand]) } : {}),
})
const grader = new EvaluationGrader({ controlPlane, executorId, leaseMs })
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort(new Error(signal)))
const healthHost = option('--health-host') ?? process.env.AGENT_EVAL_ANALYZER_HEALTH_HOST ?? '127.0.0.1'
const healthPort = integer(option('--health-port') ?? process.env.AGENT_EVAL_ANALYZER_HEALTH_PORT ?? '13101')
const health = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ status: 'ok', authority: 'eval-analyzer', executors: ['detectors', 'trace-alignment', 'clustering', 'counterfactual', 'grading'] }))
})
await new Promise<void>((resolve, reject) => { health.once('error', reject); health.listen(healthPort, healthHost, resolve) })
try { await Promise.all([analyzer.start(controller.signal), grader.start(controller.signal)]) }
finally { await new Promise<void>((resolve) => health.close(() => resolve())) }

function option(name: string): string | undefined { for (let index = 2; index < process.argv.length; index += 1) { if (process.argv[index] === name) return process.argv[index + 1]; if (process.argv[index]?.startsWith(name + '=')) return process.argv[index]!.slice(name.length + 1) } }
function options(name: string): string[] { const values: string[] = []; for (let index = 2; index < process.argv.length; index += 1) { if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[++index]!); else if (process.argv[index]?.startsWith(name + '=')) values.push(process.argv[index]!.slice(name.length + 1)) } return values }
function environmentList(name: string): string[] { return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean) }
function integer(value: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('lease must be a positive integer'); return parsed }
function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(name + ' is required'); return value.trim() }
function controlPlaneCredentials() {
  const token = option('--token') ?? process.env.AGENT_EVAL_TOKEN
  const tokenFile = option('--token-file') ?? process.env.AGENT_EVAL_TOKEN_FILE
  if (token && tokenFile) throw new Error('configure exactly one of --token or --token-file')
  if (token) return staticBearerToken(token)
  if (tokenFile) { const path = resolve(tokenFile); return rotatingBearerToken(async () => await readFile(path, 'utf8')) }
  throw new Error('configure exactly one of --token or --token-file')
}
