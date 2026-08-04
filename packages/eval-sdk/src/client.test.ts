import { describe, expect, it } from 'vitest'

import { ArtifactIntegrityError, ControlPlaneClient, ControlPlaneDeadlineError, ControlPlaneHttpError } from './client.js'
import { rotatingBearerToken, staticBearerToken } from './credentials.js'
import { AgentBackendDescriptorSchema, BenchmarkDescriptorSchema, DefectDetectorDescriptorSchema } from './index.js'
import { PluginRegistry, defineAgentBackendPlugin, defineBenchmarkAdapterPlugin, defineDefectDetectorPlugin } from './plugins.js'

describe('ControlPlaneClient', () => {
  it('uses the versioned command endpoint and parses committed acknowledgements', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new ControlPlaneClient({
      baseUrl: 'http://control-plane/',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init })
        return new Response(JSON.stringify({ schemaVersion: 1, idempotencyKey: 'idem', commandId: 'command', committedSequence: 0, committedAt: '2026-08-03T00:00:00.000Z', projectionVersion: 1 }), { status: 200 })
      },
    })
    const acknowledgement = await client.command({ schemaVersion: 1, type: 'run.cancel', commandId: 'command', idempotencyKey: 'idem', submittedAt: '2026-08-03T00:00:00.000Z', runId: 'run', reason: 'operator' })
    expect(acknowledgement.committedSequence).toBe(0)
    expect(requests[0]?.url).toBe('http://control-plane/api/v1/commands')
    expect(new Headers(requests[0]?.init?.headers).get('content-type')).toBe('application/json')
  })

  it('resolves credentials per request and sends a Bearer header', async () => {
    let token = 'first-token'
    const headers: Headers[] = []
    const client = new ControlPlaneClient({
      baseUrl: 'http://control-plane', credentialProvider: async () => token,
      fetchImpl: async (_input, init) => {
        headers.push(new Headers(init?.headers))
        return new Response(JSON.stringify({ schemaVersion: 1, protocolVersions: [1], controlPlaneVersion: '1', commands: [], queryResources: [], liveEvents: 'sse', standalone: true, cleanCutover: true, deprecatedCompatibilitySurfaces: [] }), { status: 200 })
      },
    })
    await client.capabilities(); token = 'rotated-token'; await client.capabilities()
    expect(headers.map((value) => value.get('authorization'))).toEqual(['Bearer first-token', 'Bearer rotated-token'])
  })

  it('reloads rotating credentials on every request and rejects malformed token values', async () => {
    let tokenFile = 'file-token-one\n'
    const headers: Headers[] = []
    const client = new ControlPlaneClient({
      baseUrl: 'http://control-plane', credentialProvider: rotatingBearerToken(async () => tokenFile),
      fetchImpl: async (_input, init) => {
        headers.push(new Headers(init?.headers))
        return new Response(JSON.stringify({ schemaVersion: 1, protocolVersions: [1], controlPlaneVersion: '1', commands: [], queryResources: [], liveEvents: 'sse', standalone: true, cleanCutover: true, deprecatedCompatibilitySurfaces: [] }))
      },
    })
    await client.capabilities(); tokenFile = 'file-token-two\n'; await client.capabilities()
    expect(headers.map((value) => value.get('authorization'))).toEqual(['Bearer file-token-one', 'Bearer file-token-two'])
    expect(() => staticBearerToken('')).toThrow('non-empty')
    expect(() => staticBearerToken('two tokens')).toThrow('whitespace')
  })

  it('surfaces typed Control Plane errors', async () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://control-plane',
      fetchImpl: async () => new Response(JSON.stringify({ code: 'CONFLICT', message: 'duplicate run' }), { status: 409 }),
    })
    await expect(client.capabilities()).rejects.toMatchObject<ControlPlaneHttpError>({ status: 409, code: 'CONFLICT', message: 'duplicate run' })
  })

  it('adds command identity automatically and permits explicit idempotency reuse', async () => {
    const bodies: Record<string, unknown>[] = []
    const client = new ControlPlaneClient({ baseUrl: 'http://control-plane', fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); const body = bodies.at(-1)!
      return new Response(JSON.stringify({ schemaVersion: 1, idempotencyKey: body.idempotencyKey, commandId: body.commandId, committedSequence: 0, committedAt: '2026-08-03T00:00:00.000Z', projectionVersion: 1 }))
    } })
    await client.command({ type: 'run.start', runId: 'run' })
    await client.command({ type: 'run.start', runId: 'run', idempotencyKey: 'payload-key' }, { idempotencyKey: 'reusable-key' })
    expect(bodies[0]?.idempotencyKey).toBe(bodies[0]?.commandId)
    expect(bodies[1]?.idempotencyKey).toBe('reusable-key')
  })

  it('maps query pages and enforces configurable deadlines', async () => {
    const client = new ControlPlaneClient({ baseUrl: 'http://control-plane', fetchImpl: async () => new Response(JSON.stringify({ items: [], page: { hasMore: false, total: 0 } })) })
    expect((await client.query({ resource: 'events', runId: 'run', afterSequence: -1, page: { limit: 10 } })).page.total).toBe(0)
    const slow = new ControlPlaneClient({ baseUrl: 'http://control-plane', deadlineMs: 5, fetchImpl: async (_input, init) => await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) })
    await expect(slow.capabilities()).rejects.toBeInstanceOf(ControlPlaneDeadlineError)
  })

  it('parses SSE with Last-Event-ID and verifies artifact downloads', async () => {
    const event = { schemaVersion: 1, sequence: 3, at: '2026-08-03T00:00:00.000Z', runId: 'run', type: 'run.state', producer: 'control-plane', data: { state: 'draft' } }
    let headers = new Headers()
    const stream = new ControlPlaneClient({ baseUrl: 'http://control-plane', fetchImpl: async (_input, init) => { headers = new Headers(init?.headers); return new Response(`id: 3\nevent: durable-event\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }) } })
    const received = []; for await (const item of stream.watchEvents('run', { lastEventId: 2, reconnectAttempts: 0 })) received.push(item)
    expect(headers.get('last-event-id')).toBe('2'); expect(received).toEqual([event])
    const content = new TextEncoder().encode('artifact')
    const entry = { artifactId: 'artifact', path: 'out.txt', mediaType: 'text/plain', bytes: content.byteLength, sha256: 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c', redaction: 'passed' as const, classification: 'public' as const }
    const download = new ControlPlaneClient({ baseUrl: 'http://control-plane', fetchImpl: async () => new Response(content) })
    await expect(download.downloadArtifact(entry, 'trial')).resolves.toEqual(content)
    await expect(download.downloadArtifact({ ...entry, bytes: 1 }, 'trial')).rejects.toBeInstanceOf(ArtifactIntegrityError)
  })

  it('reconnects SSE from the durable cursor and honors immediate abort', async () => {
    const events = [3, 4].map((sequence) => ({ schemaVersion: 1, sequence, at: '2026-08-03T00:00:00.000Z', runId: 'run', type: 'run.state', producer: 'control-plane', data: { state: 'draft' } }))
    const cursors: Array<string | null> = []; let request = 0
    const client = new ControlPlaneClient({ baseUrl: 'http://control-plane', fetchImpl: async (_input, init) => {
      cursors.push(new Headers(init?.headers).get('last-event-id'))
      const event = events[request++]!
      return new Response(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    const received = []; for await (const event of client.watchEvents('run', { lastEventId: 2, reconnectAttempts: 1, reconnectDelayMs: 0 })) received.push(event.sequence)
    expect(received).toEqual([3, 4]); expect(cursors).toEqual(['2', '3'])
    const aborted = new AbortController(); aborted.abort(new DOMException('stop', 'AbortError'))
    await expect(async () => { for await (const _event of client.watchEvents('run', { signal: aborted.signal })) void _event }).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('validates SSE media types and exposes typed administration methods', async () => {
    const invalid = new ControlPlaneClient({ baseUrl: 'http://control-plane', fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) })
    await expect(async () => { for await (const _event of invalid.watchEvents('run')) void _event }).rejects.toMatchObject({ code: 'INVALID_SSE_CONTENT_TYPE' })
    const requests: Array<{ url: string; body?: unknown }> = []
    const admin = new ControlPlaneClient({ baseUrl: 'http://control-plane', fetchImpl: async (input, init) => {
      requests.push({ url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      return new Response(JSON.stringify(String(input).endsWith('/status') ? { schemaVersion: 1, security: null, maintenance: null } : { generation: 2 }))
    } })
    await expect(admin.administrationStatus()).resolves.toEqual({ schemaVersion: 1, security: null, maintenance: null })
    await admin.reloadSecurity('reload-security-registry')
    expect(requests).toEqual([{ url: 'http://control-plane/api/v1/administration/status' }, { url: 'http://control-plane/api/v1/administration/security/reload', body: { confirmation: 'reload-security-registry' } }])
  })

  it('registers public external plugin definitions without orchestrator imports', () => {
    const capabilities = { nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true, absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: true, finalDiff: true, usage: 'unavailable_explicit' as const }
    const agentDescriptor = AgentBackendDescriptorSchema.parse({ schemaVersion: 1, protocolVersions: [1], id: 'sample-agent', label: 'Sample Agent', version: '1', configSchemaVersion: 1, ranked: false, evidenceLevel: 'native', capabilities })
    const benchmarkDescriptor = BenchmarkDescriptorSchema.parse({ schemaVersion: 1, protocolVersions: [1], id: 'sample-task-pack', label: 'Sample Task Pack', version: '1', official: false, nativePrimaryMetric: 'passed', verifierId: 'sample-verifier', verifierVersion: '1' })
    const detectorDescriptor = DefectDetectorDescriptorSchema.parse({ schemaVersion: 1, protocolVersions: [1], id: 'sample-detector', version: '1' })
    const registry = new PluginRegistry()
    registry.register(defineAgentBackendPlugin({ kind: 'agent-backend', descriptor: agentDescriptor, create: () => ({ descriptor: agentDescriptor }) as never }))
    registry.register(defineBenchmarkAdapterPlugin({ kind: 'benchmark-adapter', descriptor: benchmarkDescriptor, create: () => ({ descriptor: benchmarkDescriptor }) as never }))
    registry.register(defineDefectDetectorPlugin({ kind: 'defect-detector', descriptor: detectorDescriptor, create: () => ({ descriptor: detectorDescriptor, analyze: async () => [] }) }))
    expect(registry.list().map((plugin) => plugin.kind)).toEqual(['agent-backend', 'benchmark-adapter', 'defect-detector'])
  })
})
