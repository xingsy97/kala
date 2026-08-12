import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type { LLMAdapter } from '../llm/adapter.js'
import { startStandaloneIngress, type StandaloneIngress } from './standalone-ingress.js'
import { startStandaloneRuntimeUnit } from './standalone-unit.js'
import type { LoopbackHostRuntimeUnit } from './loopback-host-unit.js'

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
})
