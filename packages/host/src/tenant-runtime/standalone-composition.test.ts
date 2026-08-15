import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type { LLMAdapter } from '../llm/adapter.js'
import { startStandaloneIngress, type StandaloneIngress } from './standalone-ingress.js'
import { startStandaloneRuntimeUnit } from './standalone-unit.js'
import type { LoopbackHostRuntimeUnit } from './loopback-host-unit.js'
import { writeStandaloneRouteState } from './standalone-slot-state.js'

const roots: string[] = []
let ingress: StandaloneIngress | undefined
let unit: LoopbackHostRuntimeUnit | undefined
const llm: LLMAdapter = { name: 'standalone-test', async call() { return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } } }

afterEach(async () => {
  await ingress?.close(); ingress = undefined
  await unit?.close(); unit = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Standalone Runtime Unit composition', () => {
  it('routes the public origin to fixed local Unit with full capabilities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'standalone-runtime-unit-')); roots.push(root)
    unit = await startStandaloneRuntimeUnit({
      sessionsDir: join(root, 'sessions'),
      llm,
      defaultConfig: createConfig({ systemPrompt: 'test', tools: [] }),
    })
    ingress = await startStandaloneIngress({ port: 0, unitOrigin: unit.origin })
    const response = await fetch(`http://127.0.0.1:${ingress.port}/runtime/capabilities`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      mode: 'standalone',
      capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true },
    })
    expect(ingress.unitId).toBe('local')
    expect(unit.state).toBe('ready')
    expect((await fetch(`http://127.0.0.1:${ingress.port}/internal/runtime/quiescence`)).status).toBe(404)
  })

  it('atomically routes new requests to a newly active slot without restarting Ingress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'standalone-ingress-slots-')); roots.push(root)
    const routePath = join(root, 'route.json')
    const startBackend = async (label: string) => {
      const http = createServer((_request, response) => response.end(label))
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
      const address = http.address()
      return { http, origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` }
    }
    const blue = await startBackend('blue'), green = await startBackend('green')
    const route = { schemaVersion: 1 as const, generation: 1, activeSlot: 'blue' as const, slots: { blue: { origin: blue.origin, releaseId: 'old' }, green: { origin: green.origin, releaseId: 'next' } }, updatedAt: new Date().toISOString() }
    await writeStandaloneRouteState(routePath, route)
    ingress = await startStandaloneIngress({ port: 0, unitOrigin: blue.origin, routeStatePath: routePath })
    const origin = `http://127.0.0.1:${ingress.port}`
    expect(await fetch(origin).then((response) => response.text())).toBe('blue')
    await writeStandaloneRouteState(routePath, { ...route, generation: 2, activeSlot: 'green', updatedAt: new Date().toISOString() })
    expect(await fetch(origin).then((response) => response.text())).toBe('green')
    await Promise.all([new Promise<void>((resolve) => blue.http.close(() => resolve())), new Promise<void>((resolve) => green.http.close(() => resolve()))])
  })
})
