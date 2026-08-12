import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'
import type { LLMAdapter } from '../llm/adapter.js'
import { startStandaloneRuntimeUnit } from './standalone-unit.js'
import type { LoopbackHostRuntimeUnit } from './loopback-host-unit.js'

let unit: LoopbackHostRuntimeUnit | undefined
const roots: string[] = []
const llm: LLMAdapter = { name: 'reservation-test', async call() { return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } } }

afterEach(async () => { await unit?.close(); unit = undefined; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Standalone cutover reservation', () => {
  it('enters drain only through private reservation and can release it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cutover-reservation-')); roots.push(root)
    unit = await startStandaloneRuntimeUnit({ sessionsDir: join(root, 'sessions'), llm, defaultConfig: createConfig({ tools: [], systemPrompt: '' }) })
    const origin = unit.origin
    expect((await fetch(`${origin}/internal/runtime/quiescence`).then((response) => response.json()) as { safe: boolean }).safe).toBe(true)
    const reserved = await fetch(`${origin}/internal/runtime/cutover/reserve`, { method: 'POST' })
    expect(reserved.status).toBe(200)
    expect(unit.server.loop.isDraining()).toBe(true)
    const released = await fetch(`${origin}/internal/runtime/cutover/release`, { method: 'POST' })
    expect(released.status).toBe(200)
    expect(unit.server.loop.isDraining()).toBe(false)
  })
})
