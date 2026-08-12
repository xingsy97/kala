import { describe, expect, it, vi } from 'vitest'

import type { RuntimeModuleFactory, RuntimeModuleId } from './runtime-profile.js'
import { composeRuntimeModules } from './runtime-profile.js'

function factories(log: string[] = []): RuntimeModuleFactory[] {
  const make = (id: RuntimeModuleId, capabilities: Record<string, boolean>, requires: RuntimeModuleId[] = []): RuntimeModuleFactory => ({
    id,
    requires,
    create: () => ({
      id,
      capabilities,
      start: async () => { log.push(`start:${id}`) },
      drain: async () => { log.push(`drain:${id}`) },
      close: async () => { log.push(`close:${id}`) },
    }),
  })
  return [
    make('agent', { agent: true }),
    make('workspace', { workspace: true }, ['agent']),
    make('artifacts', { artifacts: true }, ['agent']),
    make('notifications', {}, ['agent']),
    make('benchmark', { operations: true }, ['workspace', 'artifacts']),
    make('evaluation', { pipeline: true }, ['benchmark']),
  ]
}

describe('Runtime Profile composition', () => {
  it('installs the Standalone capability superset in dependency order', async () => {
    const log: string[] = []
    const composition = await composeRuntimeModules({ profile: 'standalone', factories: factories(log) })
    expect(composition.ordered.map((module) => module.id)).toEqual(['agent', 'workspace', 'artifacts', 'notifications', 'benchmark', 'evaluation'])
    expect(composition.capabilities).toMatchObject({ agent: true, workspace: true, artifacts: true, operations: true, pipeline: true })
    await composition.start()
    await composition.drain()
    await composition.close()
    expect(log.slice(0, 6)).toEqual(composition.ordered.map((module) => `start:${module.id}`))
    expect(log.slice(-6)).toEqual([...composition.ordered].reverse().map((module) => `close:${module.id}`))
  })

  it('keeps Workspace enabled while Benchmark and Evaluation are absent in SaaS', async () => {
    const composition = await composeRuntimeModules({ profile: 'saas', factories: factories() })
    expect(composition.modules.has('workspace')).toBe(true)
    expect(composition.modules.has('benchmark')).toBe(false)
    expect(composition.modules.has('evaluation')).toBe(false)
    expect(composition.capabilities).toMatchObject({ agent: true, workspace: true, operations: false, pipeline: false })
  })

  it('rejects missing dependencies and closes modules after startup failure', async () => {
    await expect(composeRuntimeModules({ profile: 'standalone', factories: factories().filter((factory) => factory.id !== 'benchmark') })).rejects.toThrow(/missing module benchmark/)
    const close = vi.fn(async () => {})
    const failing = factories().map((factory) => factory.id === 'workspace' ? {
      ...factory,
      create: () => ({ id: 'workspace' as const, capabilities: { workspace: true }, start: async () => { throw new Error('boom') }, close }),
    } : factory)
    const composition = await composeRuntimeModules({ profile: 'saas', factories: failing })
    await expect(composition.start()).rejects.toThrow('boom')
  })
})
