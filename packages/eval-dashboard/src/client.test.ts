import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommittedAcknowledgement, ControlPlaneCapabilities, EvaluationCommand } from '@agent-kernel/eval-protocol'
import { ControlPlaneHttpError } from '@agent-kernel/eval-sdk'
import { allowedControlPlaneUrl, DashboardControlPlane, errorMessage } from './client.js'

const fixtureOrigin = globalThis.location.origin

describe('DashboardControlPlane browser security', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('refuses a Control Plane without a supported protocol version', async () => {
    const control = new DashboardControlPlane(fixtureOrigin)
    control.client.capabilities = vi.fn(async (): Promise<ControlPlaneCapabilities> => ({ schemaVersion: 1, protocolVersions: [99], controlPlaneVersion: 'x', commands: [], queryResources: [], liveEvents: 'sse', standalone: true, cleanCutover: true, deprecatedCompatibilitySurfaces: [] }))
    await expect(control.connect()).rejects.toThrow('Unsupported Control Plane protocol')
  })

  it('delegates UI commands to the shared versioned client and returns its committed acknowledgement', async () => {
    const control = new DashboardControlPlane(fixtureOrigin)
    const command: EvaluationCommand = { schemaVersion: 1, type: 'run.cancel', commandId: 'ui-command', idempotencyKey: 'ui-idempotency', submittedAt: '2026-08-03T00:00:00.000Z', runId: 'run-one', reason: 'operator request' }
    const acknowledgement: CommittedAcknowledgement = { schemaVersion: 1, idempotencyKey: command.idempotencyKey, commandId: command.commandId, committedSequence: 4, committedAt: '2026-08-03T00:00:01.000Z', projectionVersion: 5 }
    control.client.command = vi.fn(async () => acknowledgement)

    await expect(control.command(command)).resolves.toEqual(acknowledgement)
    expect(control.client.command).toHaveBeenCalledWith(command, undefined)
  })

  it('loads normalized trace content only through the contained artifact endpoint', async () => {
    const control = new DashboardControlPlane(fixtureOrigin)
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"sequence":0}\n', { status: 200 }))
    await expect(control.artifactText('normalized-events', 'trial-one')).resolves.toBe('{"sequence":0}\n')
    expect(request.mock.calls[0]![0]).toBe(fixtureOrigin + '/api/v1/artifacts/normalized-events?trialId=trial-one')
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('accept')).toContain('application/x-ndjson')
  })

  it('reconnects after a dropped event from the last durable sequence and ignores duplicate delivery', async () => {
    vi.useFakeTimers()
    const sources: FakeEventSource[] = []
    const control = new DashboardControlPlane(fixtureOrigin, (url) => { const source = new FakeEventSource(url); sources.push(source); return source })
    const received: number[] = []
    const states: string[] = []
    const stop = control.subscribeRunEvents({ runId: 'run-one', afterSequence: 2, retryMs: 10, onEvent: (event) => received.push(event.sequence), onStateChange: (state) => states.push(state) })
    expect(sources[0]!.url).toContain('runId=run-one')
    expect(sources[0]!.url).toContain('after=2')
    sources[0]!.emit('open', new Event('open'))
    sources[0]!.emit('durable-event', event(4))
    await vi.advanceTimersByTimeAsync(10)
    expect(sources[1]!.url).toContain('after=2')
    sources[1]!.emit('durable-event', event(3))
    sources[1]!.emit('durable-event', event(3))
    sources[1]!.emit('durable-event', event(4))
    expect(received).toEqual([3, 4])
    expect(states).toEqual(['connected', 'reconnecting'])
    stop()
    expect(sources[1]!.closed).toBe(true)
    vi.useRealTimers()
  })

  it('explicitly disables cross-origin EventSource because it cannot attach credentials', () => {
    const control = new DashboardControlPlane('https://eval.example.test', undefined, () => 'user-session', ['https://eval.example.test'])
    expect(() => control.subscribeRunEvents({ runId: 'run-one', afterSequence: 0, onEvent: () => undefined })).toThrow('Cross-origin live events are disabled')
  })

  it('allows only same-origin or explicitly allowlisted Control Plane URLs', () => {
    expect(allowedControlPlaneUrl('/control')).toBe(fixtureOrigin + '/control')
    expect(allowedControlPlaneUrl('https://eval.example.test/root', ['https://eval.example.test'])).toBe('https://eval.example.test/root')
    expect(() => allowedControlPlaneUrl('https://attacker.example/root')).toThrow('not allowed')
    expect(() => allowedControlPlaneUrl('javascript:alert(1)', ['javascript:alert(1)'])).toThrow('not allowed')
  })

  it('resolves rotating deployment credentials per SDK request without persisting them', async () => {
    localStorage.setItem('unrelated', 'keep')
    let token = 'short-session-one'
    const requests: Headers[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(new Headers(init?.headers))
      return new Response(JSON.stringify({ schemaVersion: 1, protocolVersions: [1], controlPlaneVersion: 'x', commands: [], queryResources: [], liveEvents: 'sse', standalone: true, cleanCutover: true, deprecatedCompatibilitySurfaces: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const control = new DashboardControlPlane(fixtureOrigin, undefined, { getToken: () => token })
    await control.connect()
    token = 'short-session-two'
    await control.connect()
    expect(requests.map((headers) => headers.get('authorization'))).toEqual(['Bearer short-session-one', 'Bearer short-session-two'])
    expect(localStorage).toHaveLength(1)
    expect(localStorage.getItem('unrelated')).toBe('keep')
    fetchMock.mockRestore()
  })

  it('sends deployment credentials for artifact reads', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('trace', { status: 200 }))
    const control = new DashboardControlPlane(fixtureOrigin, undefined, () => 'artifact-session')
    await control.artifactText('artifact', 'trial')
    const headers = new Headers(request.mock.calls[0]![1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer artifact-session')
  })

  it('downloads cross-origin reports with the current user credential through fetch', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('report', { status: 200 }))
    const control = new DashboardControlPlane('https://eval.example.test', undefined, () => 'user-session', ['https://eval.example.test'])
    await control.reportBlob('report-one', 'pdf')
    expect(request.mock.calls[0]![0]).toBe('https://eval.example.test/api/v1/reports/report-one/pdf')
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer user-session')
  })

  it('maps authorization failures and redacts internal HTTP details', () => {
    expect(errorMessage(new ControlPlaneHttpError(401, 'TOKEN_EXPIRED', 'issuer details'))).toContain('Sign in or configure')
    expect(errorMessage(new ControlPlaneHttpError(403, 'POLICY_DENIED', 'internal policy id'))).toContain('Permission denied')
    expect(errorMessage(new ControlPlaneHttpError(500, 'DB_FAILURE', 'database host secret'))).toBe('Control Plane request failed.')
    expect(errorMessage(new ControlPlaneHttpError(500, 'DB_FAILURE', 'database host secret'))).not.toContain('database')
  })
})

class FakeEventSource {
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  closed = false
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event)
    this.listeners.set(type, [...this.listeners.get(type) ?? [], callback])
  }
  close(): void { this.closed = true }
  emit(type: string, value: Event): void { for (const listener of this.listeners.get(type) ?? []) listener(value) }
}
function event(sequence: number): MessageEvent { return new MessageEvent('durable-event', { data: JSON.stringify({ schemaVersion: 1, sequence, at: '2026-08-03T00:00:00.000Z', runId: 'run-one', type: 'run.state', producer: 'control-plane', data: { state: 'running' } }) }) }
