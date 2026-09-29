import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'

import { SessionStore } from '../store/session.js'
import { KalaStateStore } from '../store/state-store.js'
import { runDagPlanTool } from './tool.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dag_plan tool', () => {
  it('creates a durable graph and schedules execution only for DAG Sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-dag-tool-'))
    roots.push(root)
    const sessions = new SessionStore(join(root, 'sessions'))
    await sessions.create({
      sessionId: 'parent',
      executionMode: 'dag',
      config: createConfig({ tools: [] }),
    })
    const state = new KalaStateStore(join(root, 'state'))
    const dagStore = state.dagStore()
    const schedule = vi.fn()
    const publishDagRun = vi.fn()
    const result = await runDagPlanTool({
      deps: {
        store: sessions,
        dagStore,
        dagScheduler: { schedule },
        publishDagRun,
      } as never,
      sessionId: 'parent',
      effect: {
        kind: 'call_tool',
        callId: 'plan-call',
        name: 'dag_plan',
        input: {
          objective: 'Build and verify',
          result_node_id: 'test',
          nodes: [
            { id: 'build', title: 'Build', instructions: 'Implement it', write_scopes: ['src'] },
            { id: 'test', title: 'Test', instructions: 'Test it', write_scopes: ['tests'] },
          ],
          edges: [{ source: 'build', target: 'test' }],
        },
      },
      aborts: new Map(),
      plannedContinuation: false,
    })
    expect(result.ok).toBe(true)
    expect(dagStore.runForSession('parent')).toMatchObject({
      status: 'running',
      graphVersion: 1,
      nodes: [{ id: 'build', status: 'ready' }, { id: 'test', status: 'pending' }],
    })
    expect(schedule).toHaveBeenCalledWith('parent')
    expect(publishDagRun).toHaveBeenCalledWith('parent')
    const firstRun = dagStore.runForSession('parent')!
    const replay = await runDagPlanTool({
      deps: { store: sessions, dagStore, dagScheduler: { schedule }, publishDagRun } as never,
      sessionId: 'parent',
      effect: {
        kind: 'call_tool',
        callId: 'plan-call',
        name: 'dag_plan',
        input: {
          objective: 'Build and verify',
          result_node_id: 'test',
          nodes: [
            { id: 'build', title: 'Build', instructions: 'Implement it', write_scopes: ['src'] },
            { id: 'test', title: 'Test', instructions: 'Test it', write_scopes: ['tests'] },
          ],
          edges: [{ source: 'build', target: 'test' }],
        },
      },
      aborts: new Map(),
      plannedContinuation: false,
    })
    expect(replay.ok).toBe(true)
    expect(dagStore.runsForSession('parent')).toHaveLength(1)
    expect(dagStore.runForSession('parent')!.id).toBe(firstRun.id)

    const next = await runDagPlanTool({
      deps: { store: sessions, dagStore, dagScheduler: { schedule }, publishDagRun } as never,
      sessionId: 'parent',
      effect: {
        kind: 'call_tool',
        callId: 'next-plan-call',
        name: 'dag_plan',
        input: {
          objective: 'A new objective',
          result_node_id: 'inspect',
          nodes: [{ id: 'inspect', title: 'Inspect', instructions: 'Inspect it' }],
          edges: [],
        },
      },
      aborts: new Map(),
      plannedContinuation: false,
    })
    expect(next.ok).toBe(true)
    expect(dagStore.runsForSession('parent')).toHaveLength(2)
    expect(dagStore.runForSession('parent')).toMatchObject({ objective: 'A new objective' })
    expect(dagStore.runForSession('parent')!.id).not.toBe(firstRun.id)
    state.close()
  })

  it('rejects use from Standard Chat', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-dag-tool-'))
    roots.push(root)
    const sessions = new SessionStore(join(root, 'sessions'))
    await sessions.create({ sessionId: 'chat', config: createConfig({ tools: [] }) })
    const result = await runDagPlanTool({
      deps: { store: sessions } as never,
      sessionId: 'chat',
      effect: { kind: 'call_tool', callId: 'call', name: 'dag_plan', input: {} },
      aborts: new Map(),
      plannedContinuation: false,
    })
    expect(result).toEqual({ ok: false, content: 'dag_plan is only available in DAG-First Sessions' })
  })
})
