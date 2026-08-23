import { createServer, type Server as HttpServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeJsonFile } from './atomic-json-file.js'
import { startDedicatedIngress, type DedicatedIngress } from './dedicated-ingress.js'
import { writeDedicatedRouteState } from './dedicated-slot-state.js'

const roots: string[] = []
const servers: HttpServer[] = []
const clients: Socket[] = []
let ingress: DedicatedIngress | undefined

afterEach(async () => {
  await ingress?.close()
  ingress = undefined
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const client of clients.splice(0)) client.destroy()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.useRealTimers()
})

async function backend(onCommit: (body: Record<string, unknown>) => void, cursor: number): Promise<string> {
  const server = createServer(async (request, response) => {
    if (request.url !== '/internal/runtime/admission/commit') { response.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    onCommit(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ committed: true, cursor }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

async function eventually(assertion: () => Promise<void>, deadlineMs = 3000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  let last: unknown
  while (Date.now() < deadline) {
    try { await assertion(); return } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 25)) }
  }
  throw last
}

describe('Stable Ingress admission', () => {
  it('closes long-lived transports without waiting for the service stop timeout', async () => {
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: 'http://127.0.0.1:9' })
    const client = connect(ingress.port, '127.0.0.1')
    clients.push(client)
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve)
      client.once('error', reject)
    })
    // An incomplete request models a transport that http.close() cannot drain
    // by itself, including the upgraded sockets used by Browser and Executor.
    client.write('GET /socket.io/ HTTP/1.1\r\nHost: localhost\r\n')
    const peerClosed = new Promise<void>((resolve) => client.once('close', () => resolve()))

    await expect(Promise.race([
      ingress.close().then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 1_000)),
    ])).resolves.toBe('closed')
    ingress = undefined
    await expect(Promise.race([
      peerClosed.then(() => 'peer-closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 1_000)),
    ])).resolves.toBe('peer-closed')
  })

  it('closes upgraded Socket.IO proxy transports and their upstream peers', async () => {
    const upstreamSockets = new Set<Socket>()
    const upstream = createServer()
    upstream.on('upgrade', (_request, socket) => {
      upstreamSockets.add(socket)
      socket.on('error', () => undefined)
      socket.once('close', () => upstreamSockets.delete(socket))
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    })
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamAddress = upstream.address()
    ingress = await startDedicatedIngress({
      port: 0,
      unitOrigin: `http://127.0.0.1:${typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0}`,
    })
    const client = connect(ingress.port, '127.0.0.1')
    clients.push(client)
    const peerClosed = new Promise<void>((resolve) => client.once('close', () => resolve()))
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
    const upgraded = new Promise<void>((resolve) => client.once('data', () => resolve()))
    client.write('GET /socket.io/ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    await eventually(async () => expect(upstreamSockets.size).toBe(1))
    await upgraded

    await expect(Promise.race([
      ingress.close().then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 1_000)),
    ])).resolves.toBe('closed')
    ingress = undefined
    await expect(Promise.race([
      peerClosed.then(() => 'peer-closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 1_000)),
    ])).resolves.toBe('peer-closed')
    // The process entrypoint exits only after this public close boundary. The
    // synthetic upstream deliberately never consumes or closes its half; the
    // real candidate Runtime observes process termination immediately after.
    for (const socket of upstreamSockets) socket.destroy()
    await eventually(async () => expect(upstreamSockets.size).toBe(0))
  })

  it('persists before acknowledging, retries duplicate identity, and reports backpressure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-ingress-admission-')); roots.push(root)
    const ledgerPath = join(root, 'ledger.json')
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: 'http://127.0.0.1:9', admissionLedgerPath: ledgerPath, admissionCapacity: 1 })
    const origin = `http://127.0.0.1:${ingress.port}`
    const body = { sessionId: 'session-1', operationId: 'operation-0001', text: 'queued', mode: 'queue' }
    const first = await fetch(`${origin}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(first.status).toBe(202)
    expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toMatchObject({ revision: 1, records: [{ operationId: 'operation-0001', state: 'pending' }] })
    expect(await fetch(`${origin}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json())).toMatchObject({ accepted: true, duplicate: true, sequence: 1 })
    expect((await fetch(`${origin}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, operationId: 'operation-0002' }) })).status).toBe(429)
  })

  it('pauses at reservation and reconciles only after the candidate continuation fence opens admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-ingress-candidate-')); roots.push(root)
    const routePath = join(root, 'route.json')
    const candidatePath = join(root, 'candidate.json')
    const ledgerPath = join(root, 'ledger.json')
    const predecessorCommits: Record<string, unknown>[] = []
    const candidateCommits: Record<string, unknown>[] = []
    const predecessor = await backend((body) => predecessorCommits.push(body), 10)
    const candidate = await backend((body) => candidateCommits.push(body), 11)
    await writeDedicatedRouteState(routePath, { schemaVersion: 1, generation: 5, activeSlot: 'blue', slots: { blue: { origin: predecessor, releaseId: 'old' }, green: { origin: candidate, releaseId: 'next' } }, updatedAt: new Date().toISOString() })
    await writeJsonFile(candidatePath, { schemaVersion: 1, deploymentId: 'deployment-0001', expectedRouteGeneration: 5, phase: 'paused', updatedAt: new Date().toISOString() })
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: predecessor, routeStatePath: routePath, candidateStatePath: candidatePath, admissionLedgerPath: ledgerPath, ingressHandoffSecret: 'test-secret' })
    const origin = `http://127.0.0.1:${ingress.port}`
    const body = { sessionId: 'session-1', operationId: 'operation-0003', text: 'during handoff', mode: 'steer' }
    expect((await fetch(`${origin}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(predecessorCommits).toHaveLength(0)
    await writeJsonFile(candidatePath, { schemaVersion: 1, deploymentId: 'deployment-0001', expectedRouteGeneration: 5, phase: 'candidate', origin: candidate, updatedAt: new Date().toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(candidateCommits).toHaveLength(0)
    await writeJsonFile(candidatePath, { schemaVersion: 1, deploymentId: 'deployment-0001', expectedRouteGeneration: 5, phase: 'admission', origin: candidate, updatedAt: new Date().toISOString() })
    await eventually(async () => { expect(candidateCommits).toHaveLength(1) })
    expect(predecessorCommits).toHaveLength(0)
    expect(candidateCommits[0]).toMatchObject(body)
    await eventually(async () => { expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toMatchObject({ records: [{ operationId: 'operation-0003', state: 'committed', sessionCursor: 11 }] }) })
  })

  it('exposes the redacted Supervisor operator snapshot through Stable Ingress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-ingress-operator-')); roots.push(root)
    const statusPath = join(root, 'operator.json')
    await writeJsonFile(statusPath, { schemaVersion: 1, topology: 'dedicated-slots', route: { generation: 6, activeSlot: 'green', activeReleaseId: 'next' }, slots: { blue: { pid: 0 }, green: { pid: 42 } }, admission: { pending: 0 }, deployment: { phase: 'completed' } })
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: 'http://127.0.0.1:9', operatorStatusPath: statusPath })
    const response = await fetch(`http://127.0.0.1:${ingress.port}/runtime/deployment/status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ topology: 'dedicated-slots', route: { generation: 6, activeSlot: 'green' }, deployment: { phase: 'completed' } })
  })

  it('resumes ordinary admission reconciliation after candidate state is cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-ingress-steady-')); roots.push(root)
    const candidatePath = join(root, 'missing-candidate.json'); const ledgerPath = join(root, 'ledger.json')
    const commits: Record<string, unknown>[] = []
    const active = await backend((body) => commits.push(body), 17)
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: active, candidateStatePath: candidatePath, admissionLedgerPath: ledgerPath, ingressHandoffSecret: 'test-secret' })
    const body = { sessionId: 'session-1', operationId: 'operation-0004', text: 'steady state', mode: 'queue' }
    const response = await fetch(`http://127.0.0.1:${ingress.port}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(202)
    await eventually(async () => { expect(commits).toHaveLength(1) })
    await eventually(async () => { expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toMatchObject({ records: [{ operationId: 'operation-0004', state: 'committed', sessionCursor: 17 }] }) })
  })

  it('retries after Runtime commit without duplicating the durable operation effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-ingress-commit-gap-')); roots.push(root)
    const ledgerPath = join(root, 'ledger.json')
    const committed = new Map<string, number>()
    let requests = 0
    let effects = 0
    const server = createServer(async (request, response) => {
      if (request.url !== '/internal/runtime/admission/commit') { response.writeHead(404).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { operationId: string }
      requests += 1
      if (!committed.has(body.operationId)) { committed.set(body.operationId, 23); effects += 1 }
      response.writeHead(200, { 'content-type': 'application/json' })
      // Simulate Ingress/process failure after the Runtime's durable commit but
      // before its ledger receipt can be recorded. The retry must receive the
      // Runtime's original idempotent outcome without replaying the effect.
      response.end(requests === 1 ? '{' : JSON.stringify({ committed: true, cursor: committed.get(body.operationId) }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const active = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: active, admissionLedgerPath: ledgerPath, ingressHandoffSecret: 'test-secret' })
    const body = { sessionId: 'session-1', operationId: 'operation-commit-gap', text: 'exactly once', mode: 'queue' }
    expect((await fetch(`http://127.0.0.1:${ingress.port}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(202)
    await eventually(async () => {
      expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toMatchObject({ records: [{ operationId: body.operationId, state: 'committed', sessionCursor: 23 }] })
    })
    expect(requests).toBeGreaterThanOrEqual(2)
    expect(effects).toBe(1)
  })

  it('keeps the ledger pending until Runtime proves the operation exists in Session JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-ingress-jsonl-barrier-')); roots.push(root)
    const ledgerPath = join(root, 'ledger.json')
    let attempts = 0
    const server = createServer(async (request, response) => {
      if (request.url !== '/internal/runtime/admission/commit') { response.writeHead(404).end(); return }
      for await (const _chunk of request) { /* consume request body */ }
      attempts += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(attempts === 1 ? JSON.stringify({ committed: false }) : JSON.stringify({ committed: true, cursor: 31 }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const active = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: active, admissionLedgerPath: ledgerPath, ingressHandoffSecret: 'test-secret' })
    const body = { sessionId: 'session-1', operationId: 'operation-jsonl-barrier', text: 'durable first', mode: 'queue' }
    expect((await fetch(`http://127.0.0.1:${ingress.port}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(202)
    await eventually(async () => { expect(attempts).toBeGreaterThanOrEqual(1) })
    const afterFirst = JSON.parse(await readFile(ledgerPath, 'utf8')) as { records: Array<{ state: string }> }
    expect(afterFirst.records[0]?.state).not.toBe('committed')
    await eventually(async () => {
      expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toMatchObject({ records: [{ operationId: body.operationId, state: 'committed', sessionCursor: 31 }] })
    })
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  it('does not let one uncommitted Session block admission for another Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-ingress-head-of-line-')); roots.push(root)
    const ledgerPath = join(root, 'ledger.json')
    const commits: string[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sessionId: string }
      commits.push(body.sessionId)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body.sessionId === 'session-blocked' ? JSON.stringify({ committed: false }) : JSON.stringify({ committed: true, cursor: 41 }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, admissionLedgerPath: ledgerPath, ingressHandoffSecret: 'test-secret' })
    const origin = `http://127.0.0.1:${ingress.port}`
    for (const [sessionId, operationId] of [['session-blocked', 'operation-blocked'], ['session-ready', 'operation-ready']] as const) {
      expect((await fetch(`${origin}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, operationId, text: 'hello', mode: 'queue' }) })).status).toBe(202)
    }
    await eventually(async () => {
      expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toMatchObject({ records: [
        { operationId: 'operation-blocked', state: 'pending', attempts: expect.any(Number), error: expect.stringContaining('not committed') },
        { operationId: 'operation-ready', state: 'committed', sessionCursor: 41 },
      ] })
    })
    expect(commits).toContain('session-ready')
    const status = await fetch(`${origin}/runtime/admission/messages/operation-blocked`).then((response) => response.json())
    expect(status).toMatchObject({ operationId: 'operation-blocked', state: 'pending', attempts: expect.any(Number), lastError: expect.stringContaining('not committed') })
  })

  it('marks an explicitly missing target Session as failed instead of retrying forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-ingress-missing-session-')); roots.push(root)
    const ledgerPath = join(root, 'ledger.json')
    let attempts = 0
    const server = createServer(async (request, response) => {
      attempts += 1
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'The target Session no longer exists', code: 'SESSION_NOT_FOUND' }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    ingress = await startDedicatedIngress({ port: 0, unitOrigin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, admissionLedgerPath: ledgerPath, ingressHandoffSecret: 'test-secret' })
    const origin = `http://127.0.0.1:${ingress.port}`
    expect((await fetch(`${origin}/runtime/admission/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'deleted-session', operationId: 'operation-missing-session', text: 'hello', mode: 'queue' }) })).status).toBe(202)
    await eventually(async () => {
      expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toMatchObject({ records: [{ state: 'failed', failedAt: expect.any(String), error: expect.stringContaining('no longer exists') }] })
    })
    expect(attempts).toBe(1)
    await expect(fetch(`${origin}/runtime/admission/status`).then((response) => response.json())).resolves.toMatchObject({ pending: 0, leased: 0, failed: 1 })
  })
})
