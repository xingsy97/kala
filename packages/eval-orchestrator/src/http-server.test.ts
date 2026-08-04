import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createConnection, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import type { EvaluationRunSpec } from '@agent-kernel/eval-protocol'
import { ControlPlaneClient } from '@agent-kernel/eval-sdk'

import { EvaluationControlPlane } from './control-plane.js'
import { createEvaluationHttpServer } from './http-server.js'
import { BearerTokenAuthenticator } from './auth.js'
import { RegisteredTaskCatalog } from './task-catalog.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const runFile = promisify(execFile)
const servers: Array<ReturnType<typeof createEvaluationHttpServer>> = []
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))))

const operatorToken = 'operator-test-token'
const auth = new BearerTokenAuthenticator({ schemaVersion: 1, keys: [
  { key: operatorToken, principal: { schemaVersion: 1, principalId: 'operator-one', kind: 'user', role: 'operator', scopes: ['platform:read', 'evaluation:read', 'evaluation:write', 'evidence:read', 'governance:write', 'admin'] } },
  { key: 'worker-test-token', principal: { schemaVersion: 1, principalId: 'worker-one-principal', kind: 'service', role: 'worker', serviceId: 'upload-worker', scopes: ['platform:read', 'worker:execute'] } },
  { key: 'worker-two-token', principal: { schemaVersion: 1, principalId: 'worker-two-principal', kind: 'service', role: 'worker', serviceId: 'worker-two', scopes: ['platform:read', 'worker:execute'] } },
  { key: 'analyzer-test-token', principal: { schemaVersion: 1, principalId: 'analyzer-one-principal', kind: 'service', role: 'analyzer', serviceId: 'analyzer-one', scopes: ['platform:read', 'evaluation:read', 'analyzer:execute'] } },
  { key: 'viewer-test-token', principal: { schemaVersion: 1, principalId: 'viewer-one', kind: 'user', role: 'viewer', scopes: ['platform:read', 'evaluation:read', 'evidence:read'] } },
] })

async function start(journalPath?: string, administration?: Parameters<typeof createEvaluationHttpServer>[1]['administration']) {
  const spec = JSON.parse(await readFile(join(packageRoot, '..', 'eval-protocol', 'fixtures', 'canonical-run-spec-v1.json'), 'utf8')) as EvaluationRunSpec
  const directory = await mkdtemp(join(tmpdir(), 'eval-http-'))
  const catalog = new RegisteredTaskCatalog()
  catalog.register(spec.taskPack.evaluatedSlice.sliceManifestHash, ['task-one', 'task-two'])
  const controlPlane = new EvaluationControlPlane({ journalPath: journalPath ?? join(directory, 'journal.jsonl'), taskCatalog: catalog })
  await controlPlane.initialize()
  const server = createEvaluationHttpServer(controlPlane, { authenticator: auth, administration })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return { controlPlane, client: new ControlPlaneClient({ baseUrl: 'http://127.0.0.1:' + String(port), credentialProvider: () => operatorToken }), spec, journalPath: controlPlane.journal.path, port }
}

describe('versioned Control Plane HTTP API', () => {
  it('rejects missing credentials with 401 and cross-role access with 403', async () => {
    const { port } = await start()
    const anonymous = await fetch('http://127.0.0.1:' + String(port) + '/api/v1/capabilities')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer')
    const worker = new ControlPlaneClient({ baseUrl: 'http://127.0.0.1:' + String(port), credentialProvider: () => 'worker-test-token' })
    await expect(worker.query({ resource: 'runs', page: { limit: 10 } })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    await expect(worker.registerWorker({ schemaVersion: 1, workerId: 'different-worker', signingKeyReference: 'fixture-key', workerVersion: '1', protocolVersions: [1], sandboxProviders: [], agentBackends: [], benchmarkAdapters: [], capacity: { cpu: 1, memoryMb: 1, diskMb: 1, gpu: 0, maxTrials: 1 } })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
  })

  it('returns 401 before parsing or resource lookup on every protected endpoint', async () => {
    const { port } = await start()
    const requests: Array<[string, string]> = [
      ['GET', '/api/v1/capabilities'], ['GET', '/api/v1/events'], ['GET', '/api/v1/archive-documents/missing'],
      ['GET', '/api/v1/artifacts/missing'], ['GET', '/api/v1/analysis-artifacts/job/output'], ['GET', '/api/v1/reports/report/json'],
      ['PUT', '/api/v1/artifacts/stage/trial'], ['PUT', '/api/v1/artifacts/stage/analysis'],
      ...['commands', 'query', 'workers/register', 'workers/heartbeat', 'leases/acquire', 'leases/heartbeat', 'leases/progress', 'leases/expire', 'analysis/expire', 'results/commit'].map((path) => ['POST', '/api/v1/' + path] as [string, string]),
    ]
    for (const [method, path] of requests) {
      const response = await fetch('http://127.0.0.1:' + String(port) + path, { method, body: method === 'POST' ? '{}' : undefined })
      expect(response.status, method + ' ' + path).toBe(401)
      expect(response.headers.get('www-authenticate'), path).toContain('Bearer')
    }
  })

  it('rejects wrong roles, Worker A impersonating B, Analyzer impersonation, and governance commands', async () => {
    const { port } = await start()
    const baseUrl = 'http://127.0.0.1:' + String(port)
    const post = async (token: string, path: string, body: unknown) => await fetch(baseUrl + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post('viewer-test-token', '/api/v1/leases/expire', {})).status).toBe(403)
    expect((await post('worker-test-token', '/api/v1/workers/heartbeat', { workerId: 'worker-two' })).status).toBe(403)
    expect((await post('worker-test-token', '/api/v1/leases/acquire', { workerId: 'worker-two', leaseMs: 1000 })).status).toBe(403)
    const analyzerImpersonation = { schemaVersion: 1, type: 'analysis.job.start', commandId: 'impersonate', idempotencyKey: 'impersonate', submittedAt: '2026-08-03T00:00:00.000Z', jobId: 'job-one', executorId: 'analyzer-two', leaseMs: 1000 }
    expect((await post('analyzer-test-token', '/api/v1/commands', analyzerImpersonation)).status).toBe(403)
    for (const type of ['leaderboard.publish', 'failure-cluster.promote', 'defect.promote']) {
      const response = await post('viewer-test-token', '/api/v1/commands', { schemaVersion: 1, type, commandId: type, idempotencyKey: type, submittedAt: '2026-08-03T00:00:00.000Z' })
      expect(response.status, type).toBe(403)
    }
  })

  it('rejects malformed and revoked tokens uniformly', async () => {
    const { port } = await start()
    const url = 'http://127.0.0.1:' + String(port) + '/api/v1/capabilities'
    for (const authorization of ['Bearer wrong-token', 'Bearer worker-test-token extra', 'Basic ' + operatorToken, 'bearer ' + operatorToken]) {
      expect((await fetch(url, { headers: { authorization } })).status, authorization).toBe(401)
    }
  })

  it('protects administration metadata and reload with admin scope and exact confirmation', async () => {
    const reloads: string[] = []
    const metadata = { schemaVersion: 1 as const, loadedAt: '2026-08-03T00:00:00.000Z', generation: 1, principals: [], serviceKeys: [], trustKeys: [], reloadAudit: [] }
    const { port } = await start(undefined, { securityMetadata: () => metadata, maintenanceStatus: async () => ({ retentionSweeps: [], backups: [], restoreDrills: [], audit: [] }), reloadSecurity: async (actorId) => { reloads.push(actorId); return { ...metadata, generation: 2 } } })
    const base = 'http://127.0.0.1:' + String(port)
    const viewer = await fetch(base + '/api/v1/administration/status', { headers: { authorization: 'Bearer viewer-test-token' } })
    expect(viewer.status).toBe(403)
    const status = await fetch(base + '/api/v1/administration/status', { headers: { authorization: 'Bearer ' + operatorToken } })
    expect(await status.json()).toMatchObject({ security: { generation: 1 }, maintenance: { backups: [] } })
    const sdk = new ControlPlaneClient({ baseUrl: base, credentialProvider: () => operatorToken })
    await expect(sdk.administrationStatus()).resolves.toMatchObject({ security: { generation: 1 }, maintenance: { backups: [] } })
    const wrong = await fetch(base + '/api/v1/administration/security/reload', { method: 'POST', headers: { authorization: 'Bearer ' + operatorToken, 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'reload' }) })
    expect(wrong.status).toBe(400); expect(reloads).toEqual([])
    await expect(sdk.reloadSecurity('reload-security-registry')).resolves.toMatchObject({ generation: 2 })
    expect(reloads).toEqual(['operator-one'])
  })

  it('accepts global CLI options before resources and rejects missing option values', async () => {
    const { port } = await start(undefined, { maintenanceStatus: async () => ({ backups: [] }) })
    const cli = join(packageRoot, 'bin/eval-cli.ts'); const baseUrl = 'http://127.0.0.1:' + String(port)
    const status = JSON.parse((await runFile(process.execPath, ['--import', 'tsx', cli, '--url', baseUrl, '--token', operatorToken, 'admin', 'status'], { cwd: packageRoot })).stdout)
    expect(status).toMatchObject({ schemaVersion: 1, maintenance: { backups: [] } })
    await expect(runFile(process.execPath, ['--import', 'tsx', cli, 'admin', 'status', '--url'], { cwd: packageRoot })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('requires a value') })
  })

  it('provides CLI/Web client parity with durable projection and committed acknowledgements', async () => {
    const { controlPlane, client, spec } = await start()
    const command = { schemaVersion: 1 as const, type: 'run.create' as const, commandId: 'create-http', idempotencyKey: 'idem-http', submittedAt: '2026-08-03T00:00:00.000Z', spec }
    const first = await client.command(command)
    expect(await client.command(command)).toEqual(first)
    const queried = await client.query<{ accepted: { spec: EvaluationRunSpec } }>({ resource: 'run', runId: spec.runId })
    expect(queried.accepted.spec).toEqual(controlPlane.projection.runs.get(spec.runId)?.accepted.spec)
    expect(await client.capabilities()).toMatchObject({ standalone: true, cleanCutover: true, deprecatedCompatibilitySurfaces: [] })
  })

  it('executes the real CLI against the same HTTP commands and queries as the SDK client', async () => {
    const { client, spec, port } = await start()
    const directory = await mkdtemp(join(tmpdir(), 'eval-cli-parity-'))
    const command = { schemaVersion: 1 as const, type: 'run.create' as const, commandId: 'create-real-cli', idempotencyKey: 'idem-real-cli', submittedAt: '2026-08-03T00:00:00.000Z', spec }
    const query = { resource: 'run' as const, runId: spec.runId }
    const commandPath = join(directory, 'command.json'); const queryPath = join(directory, 'query.json')
    await writeFile(commandPath, JSON.stringify(command)); await writeFile(queryPath, JSON.stringify(query))
    const baseUrl = 'http://127.0.0.1:' + String(port)
    const cliAck = JSON.parse((await runFile(process.execPath, ['--import', 'tsx', join(packageRoot, 'bin/eval-cli.ts'), 'command', '--file', commandPath, '--url', baseUrl, '--token', operatorToken], { cwd: packageRoot })).stdout)
    expect(cliAck).toEqual(await client.command(command))
    const cliProjection = JSON.parse((await runFile(process.execPath, ['--import', 'tsx', join(packageRoot, 'bin/eval-cli.ts'), 'query', '--file', queryPath, '--url', baseUrl, '--token', operatorToken], { cwd: packageRoot })).stdout)
    expect(cliProjection).toEqual(await client.query(query))
  })

  it('recovers the same authoritative HTTP query after a Control Plane restart', async () => {
    const first = await start()
    await first.client.command({ schemaVersion: 1, type: 'run.create', commandId: 'create-restart', idempotencyKey: 'idem-restart', submittedAt: '2026-08-03T00:00:00.000Z', spec: first.spec })
    const before = await first.client.query({ resource: 'run', runId: first.spec.runId })
    await new Promise<void>((resolve) => servers.shift()!.close(() => resolve()))
    const restarted = await start(first.journalPath)
    expect(await restarted.client.query({ resource: 'run', runId: first.spec.runId })).toEqual(before)
  })

  it('returns the same committed acknowledgement after restart and rejects an idempotency collision over HTTP', async () => {
    const first = await start()
    const command = { schemaVersion: 1 as const, type: 'run.create' as const, commandId: 'create-durable-ack', idempotencyKey: 'idem-durable-ack', submittedAt: '2026-08-03T00:00:00.000Z', spec: first.spec }
    const acknowledgement = await first.client.command(command)
    const transactionsBeforeRestart = first.controlPlane.projection.transactionCount
    await new Promise<void>((resolve) => servers.shift()!.close(() => resolve()))

    const restarted = await start(first.journalPath)
    expect(await restarted.client.command(command)).toEqual(acknowledgement)
    expect(restarted.controlPlane.projection.transactionCount).toBe(transactionsBeforeRestart)
    await expect(restarted.client.command({ ...command, type: 'run.start', runId: command.spec.runId } as never))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(restarted.controlPlane.projection.transactionCount).toBe(transactionsBeforeRestart)
  })

  it('does not expose unexpected internal error messages', async () => {
    const { port } = await start(undefined, { maintenanceStatus: async () => { throw new Error('secret filesystem location') } })
    const response = await fetch('http://127.0.0.1:' + String(port) + '/api/v1/administration/status', { headers: { authorization: 'Bearer ' + operatorToken } })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Control Plane request failed' })
  })

  it('serves durable SSE catch-up starting after the requested sequence', async () => {
    const { client, spec, port } = await start()
    await client.command({ schemaVersion: 1, type: 'run.create', commandId: 'create-sse', idempotencyKey: 'idem-sse-create', submittedAt: '2026-08-03T00:00:00.000Z', spec })
    await client.command({ schemaVersion: 1, type: 'run.start', commandId: 'start-sse', idempotencyKey: 'idem-sse-start', submittedAt: '2026-08-03T00:00:01.000Z', runId: spec.runId })
    const controller = new AbortController()
    const response = await fetch('http://127.0.0.1:' + String(port) + '/api/v1/events?runId=' + encodeURIComponent(spec.runId) + '&after=0', { headers: { authorization: 'Bearer ' + operatorToken }, signal: controller.signal })
    const reader = response.body!.getReader()
    const decoded = new TextDecoder().decode((await reader.read()).value)
    controller.abort()
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(decoded).not.toContain('id: 0\n')
    expect(decoded).toContain('id: 1\n')
    expect(decoded).toContain('event: durable-event')
  })

  it('resumes durable SSE catch-up after a dropped connection without replaying acknowledged events', async () => {
    const { client, spec, port } = await start()
    await client.command({ schemaVersion: 1, type: 'run.create', commandId: 'create-sse-reconnect', idempotencyKey: 'idem-sse-reconnect-create', submittedAt: '2026-08-03T00:00:00.000Z', spec })
    const first = new AbortController()
    const initial = await fetch('http://127.0.0.1:' + String(port) + '/api/v1/events?runId=' + encodeURIComponent(spec.runId), { headers: { authorization: 'Bearer ' + operatorToken }, signal: first.signal })
    const initialBody = new TextDecoder().decode((await initial.body!.getReader().read()).value)
    first.abort()
    expect(initialBody).toContain('id: 0\n')

    await client.command({ schemaVersion: 1, type: 'run.start', commandId: 'start-sse-reconnect', idempotencyKey: 'idem-sse-reconnect-start', submittedAt: '2026-08-03T00:00:01.000Z', runId: spec.runId })
    const reconnect = new AbortController()
    const resumed = await fetch('http://127.0.0.1:' + String(port) + '/api/v1/events?runId=' + encodeURIComponent(spec.runId), { headers: { 'last-event-id': '0', authorization: 'Bearer ' + operatorToken }, signal: reconnect.signal })
    const resumedBody = new TextDecoder().decode((await resumed.body!.getReader().read()).value)
    reconnect.abort()
    expect(resumedBody).not.toContain('id: 0\n')
    expect(resumedBody).toContain('id: 1\n')
  })

  it('discards an interrupted HTTP artifact body and accepts one verified retry', async () => {
    const { client, controlPlane, spec, port } = await start()
    await client.command({ schemaVersion: 1, type: 'run.create', commandId: 'create-upload-interruption', idempotencyKey: 'idem-upload-interruption', submittedAt: '2026-08-03T00:00:00.000Z', spec })
    await client.command({ schemaVersion: 1, type: 'run.start', commandId: 'start-upload-interruption', idempotencyKey: 'idem-start-upload-interruption', submittedAt: '2026-08-03T00:00:01.000Z', runId: spec.runId })
    const workerClient = new ControlPlaneClient({ baseUrl: 'http://127.0.0.1:' + String(port), credentialProvider: () => 'worker-test-token' })
    await workerClient.registerWorker({ schemaVersion: 1, workerId: 'upload-worker', signingKeyReference: 'fixture-key', workerVersion: '1', protocolVersions: [1], sandboxProviders: ['docker'], agentBackends: ['agent-runlab'], benchmarkAdapters: ['swe-bench'], capacity: { cpu: 8, memoryMb: 16384, diskMb: 65536, gpu: 0, maxTrials: 1 } })
    const lease = (await workerClient.acquireLease('upload-worker', 10_000))!
    const content = Buffer.from('canonical artifact bytes')
    const metadata = {
      path: lease.runId + '/' + lease.trialId + '/interrupted.bin', mediaType: 'application/octet-stream',
      bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex'),
    }
    await interruptedUpload(port, lease, metadata, content.subarray(0, 5))
    await expect(controlPlane.artifactStore.readRegisteredFile(metadata)).rejects.toMatchObject({ code: 'ENOENT' })
    await workerClient.stageTrialArtifact({ leaseId: lease.leaseId, commitToken: lease.commitToken, ...metadata, content })
    await expect(controlPlane.artifactStore.readRegisteredFile(metadata)).resolves.toMatchObject({ bytes: content.byteLength, sha256: metadata.sha256, content })
  })
})

async function interruptedUpload(port: number, lease: { leaseId: string; commitToken: string }, metadata: { path: string; mediaType: string; bytes: number; sha256: string }, partial: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error) })
    socket.once('connect', () => {
      const headers = [
        'PUT /api/v1/artifacts/stage/trial HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close', 'Authorization: Bearer worker-test-token',
        'Content-Type: application/octet-stream', 'Content-Length: ' + String(metadata.bytes),
        'x-agent-eval-artifact-path: ' + metadata.path, 'x-agent-eval-artifact-media-type: ' + metadata.mediaType,
        'x-agent-eval-artifact-bytes: ' + String(metadata.bytes), 'x-agent-eval-artifact-sha256: ' + metadata.sha256,
        'x-agent-eval-lease-id: ' + lease.leaseId, 'x-agent-eval-commit-token: ' + lease.commitToken, '', '',
      ].join('\r\n')
      socket.write(headers); socket.write(partial, () => { socket.destroy(); resolve() })
    })
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
}
