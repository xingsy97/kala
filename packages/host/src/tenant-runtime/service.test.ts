import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'
import { AGENT_RUNTIME_CAPABILITIES, PROTOCOL_VERSION, type ServerSessionsPayload } from '@agent-kernel/shared'
import { io as connect, type Socket } from 'socket.io-client'

import type { LLMAdapter } from '../llm/adapter.js'
import { startLoopbackHostRuntimeUnit } from './loopback-host-unit.js'
import { startTenantRuntimeService, type TenantRuntimeService } from './service.js'

const roots: string[] = []
const sockets: Socket[] = []
let host: TenantRuntimeService | undefined
const llm: LLMAdapter = { name: 'tenant-test', async call() { return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } } }

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await host?.close(); host = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('multi-tenant Host composition', () => {
  it('rejects direct traffic without the trusted Gateway service credential', async () => {
    host = await startTenantRuntimeService({ port: 0, ingressSecret: 'secret', resolveUnitId: () => 'a', factory: async () => { throw new Error('must not load') } })
    const response = await fetch(`http://127.0.0.1:${host.port}/runtime/capabilities`, { headers: { 'x-agent-runlab-runtime-unit': 'a' } })
    expect(response.status).toBe(404)
    expect(host.units.list()).toHaveLength(0)
  })

  it('requires a trusted client certificate on the Gateway-to-Runtime listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-mtls-')); roots.push(root)
    const tls = await createTestMtls(root)
    host = await startTenantRuntimeService({
      port: 0,
      ingressSecret: 'secret',
      tls: { key: tls.serverKey, cert: tls.serverCert, ca: tls.ca },
      resolveUnitId: () => undefined,
      factory: async () => { throw new Error('must not load') },
    })
    await expect(httpsGet(host.port, tls.ca)).rejects.toThrow()
    expect((await httpsGet(host.port, tls.ca, tls.clientCert, tls.clientKey)).status).toBe(404)
  })

  it('routes two complete Socket.IO runtimes with identical session ids without leakage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-tenant-host-')); roots.push(root)
    host = await startTenantRuntimeService({
      port: 0,
      resolveUnitId: (request) => String(request.headers['x-runtime-unit'] ?? ''),
      factory: async (id) => startLoopbackHostRuntimeUnit(id, {
        sessionsDir: join(root, id, 'sessions'),
        llm,
        defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
        capabilities: AGENT_RUNTIME_CAPABILITIES,
      }),
    })

    const origin = `http://127.0.0.1:${host.port}`
    const a = connect(`${origin}/dashboard`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': 'a' }, auth: { sessionId: 'same-session', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
    const b = connect(`${origin}/dashboard`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': 'b' }, auth: { sessionId: 'same-session', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
    sockets.push(a, b)
    await Promise.all([a, b].map((socket) => new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })))

    await a.timeout(2_000).emitWithAck('client:create_session', { sessionId: 'only-a', workspaceId: 'same-workspace', workspaceName: 'A' })
    const list = async (socket: Socket): Promise<ServerSessionsPayload> => await new Promise((resolve) => {
      socket.once('server:sessions', resolve)
      socket.emit('client:list_sessions', {})
    })
    expect((await list(a)).sessions.some((session) => session.sessionId === 'only-a')).toBe(true)
    expect((await list(b)).sessions.some((session) => session.sessionId === 'only-a')).toBe(false)
    expect(host.units.list()).toHaveLength(2)
    expect(host.status().state).toBe('ready')
    await host.suspendUnit('a')
    expect(host.units.list().map((unit) => unit.id)).toEqual(['b'])
    expect(b.connected).toBe(true)
  })

  it('isolates HTTP artifacts when tenants reuse the same session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-tenant-artifacts-')); roots.push(root)
    host = await startTenantRuntimeService({
      port: 0,
      resolveUnitId: (request) => String(request.headers['x-runtime-unit'] ?? ''),
      factory: async (id) => startLoopbackHostRuntimeUnit(id, {
        sessionsDir: join(root, id, 'sessions'), llm,
        defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }), capabilities: AGENT_RUNTIME_CAPABILITIES,
      }),
    })
    const origin = `http://127.0.0.1:${host.port}`
    const headers = (unit: string): Record<string, string> => ({ 'x-runtime-unit': unit, 'content-type': 'application/json' })
    for (const unit of ['a', 'b']) {
      const socket = connect(`${origin}/dashboard`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': unit }, auth: { sessionId: 'shared', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
      sockets.push(socket); await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
      await socket.timeout(2_000).emitWithAck('client:create_session', { sessionId: 'shared', workspaceId: 'shared', workspaceName: unit })
    }
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII='
    const registered = await fetch(`${origin}/session-artifacts/register`, { method: 'POST', headers: headers('a'), body: JSON.stringify({ sessionId: 'shared', fileName: 'a.png', data: png }) })
    expect(registered.status).toBe(200)
    const { artifactId } = await registered.json() as { artifactId: string }
    expect((await fetch(`${origin}/session-artifacts/${artifactId}?sessionId=shared`, { headers: { 'x-runtime-unit': 'a' } })).status).toBe(200)
    expect((await fetch(`${origin}/session-artifacts/${artifactId}?sessionId=shared`, { headers: { 'x-runtime-unit': 'b' } })).status).toBe(404)
    expect(host.units.list()).toHaveLength(2)
    // Push/VAPID state is constructed below each Unit root, never globally.
    expect(join(root, 'a', 'push-vapid.json')).not.toBe(join(root, 'b', 'push-vapid.json'))
  })

  it('attaches a Unit-local executor and executes filesystem tools inside its workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-unit-workspace-')); roots.push(root)
    const workspaceDir = join(root, 'workspace')
    await mkdir(workspaceDir)
    const unit = await startLoopbackHostRuntimeUnit('workspace-unit', {
      sessionsDir: join(root, 'sessions'), workspaceDir, llm,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
      capabilities: AGENT_RUNTIME_CAPABILITIES,
    })
    const attached = unit.server.executorsSnapshot()
    expect(attached).toHaveLength(1)
    expect(attached[0]).toMatchObject({
      workspaceId: unit.executor!.workspaceId,
      workspaceName: 'Workspace',
      sandboxRoots: [workspaceDir],
    })
    expect(attached[0]!.tools).toEqual(expect.arrayContaining(['write_file', 'read_file', 'bash']))
    await unit.close()
  })

  it('isolates executor registries when tenants reuse workspace ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-tenant-executors-')); roots.push(root)
    host = await startTenantRuntimeService({ port: 0, resolveUnitId: (request) => String(request.headers['x-runtime-unit'] ?? ''), factory: async (id) => startLoopbackHostRuntimeUnit(id, { sessionsDir: join(root, id, 'sessions'), llm, defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }), capabilities: AGENT_RUNTIME_CAPABILITIES }) })
    const origin = `http://127.0.0.1:${host.port}`
    for (const unit of ['a', 'b']) {
      const executor = connect(`${origin}/executor`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': unit }, auth: { role: 'executor', clientVersion: PROTOCOL_VERSION } })
      sockets.push(executor); await new Promise<void>((resolve, reject) => { executor.once('connect', resolve); executor.once('connect_error', reject) })
      executor.emit('executor:announce', { executorId: `executor-${unit}`, workspaceId: 'same-workspace', workspaceName: unit, tools: ['read'], runtime: 'node', runtimeVersion: '22' })
      const dashboard = connect(`${origin}/dashboard`, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': unit }, auth: { sessionId: 'same', role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
      sockets.push(dashboard); await new Promise<void>((resolve, reject) => { dashboard.once('connect', resolve); dashboard.once('connect_error', reject) })
      const payload = await new Promise<{ executors: { executorId: string }[] }>((resolve) => { dashboard.once('server:executors', resolve); dashboard.emit('client:list_executors', {}) })
      expect(payload.executors.map((entry) => entry.executorId)).toEqual([`executor-${unit}`])
    }
  })
})

async function createTestMtls(root: string): Promise<{
  ca: Buffer
  serverKey: Buffer
  serverCert: Buffer
  clientKey: Buffer
  clientCert: Buffer
}> {
  const run = (...args: string[]): void => {
    execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
  }
  await writeFile(join(root, 'server.ext'), 'subjectAltName=DNS:runtime-host\nextendedKeyUsage=serverAuth\n')
  await writeFile(join(root, 'client.ext'), 'extendedKeyUsage=clientAuth\n')
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.pem')
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=runtime-host', '-keyout', 'server.key', '-out', 'server.csr')
  run('x509', '-req', '-days', '1', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', 'server.ext', '-out', 'server.pem')
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=gateway', '-keyout', 'client.key', '-out', 'client.csr')
  run('x509', '-req', '-days', '1', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-extfile', 'client.ext', '-out', 'client.pem')
  return {
    ca: await readFile(join(root, 'ca.pem')),
    serverKey: await readFile(join(root, 'server.key')),
    serverCert: await readFile(join(root, 'server.pem')),
    clientKey: await readFile(join(root, 'client.key')),
    clientCert: await readFile(join(root, 'client.pem')),
  }
}

function httpsGet(port: number, ca: Buffer, cert?: Buffer, key?: Buffer): Promise<{ status: number }> {
  return new Promise((resolveRequest, reject) => {
    const request = httpsRequest({
      host: '127.0.0.1',
      port,
      path: '/runtime/capabilities',
      servername: 'runtime-host',
      ca,
      ...(cert && key ? { cert, key } : {}),
      minVersion: 'TLSv1.3',
      headers: { 'x-agent-runlab-ingress-secret': 'secret' },
    }, (response) => {
      response.resume()
      response.once('end', () => resolveRequest({ status: response.statusCode ?? 0 }))
    })
    request.once('error', reject)
    request.end()
  })
}
