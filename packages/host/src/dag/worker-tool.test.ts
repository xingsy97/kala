import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'

import { SessionStore } from '../store/session.js'
import { KalaStateStore } from '../store/state-store.js'
import { bindDagWorkerSession, runDagWorkerTool, unbindDagWorkerSession } from './worker-tool.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DAG worker tools', () => {
  it('updates progress only for the securely bound leased child Session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-dag-worker-tool-'))
    roots.push(root)
    const sessions = new SessionStore(join(root, 'sessions'))
    await sessions.create({ sessionId: 'parent', executionMode: 'dag', config: createConfig({ tools: [] }) })
    const state = new KalaStateStore(join(root, 'state'))
    const dagStore = state.dagStore()
    const run = dagStore.createRun('parent', 'Work', 'create')
    dagStore.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'work',
      nodes: [{ id: 'work', title: 'Work', instructions: 'Do it' }],
      edges: [],
    }, 'graph')
    const workerId = 'worker'
    const node = dagStore.claimReadyNodes(run.id, workerId, 1, 60_000)[0]!
    const callId = `dag:${run.id}:${node.id}:${node.attempt}`
    const child = await sessions.create({
      sessionId: 'child',
      parentSessionId: 'parent',
      parentCallId: callId,
      config: createConfig({ tools: [] }),
    })
    const publishDagRun = vi.fn()
    const context = {
      deps: { store: sessions, dagStore, publishDagRun },
      sessionId: child.sessionId,
      effect: {
        kind: 'call_tool' as const,
        callId: 'progress-call',
        name: 'dag_report_progress',
        input: { message: 'Halfway done' },
      },
      aborts: new Map(),
      plannedContinuation: false,
    }

    expect((await runDagWorkerTool(context as never)).ok).toBe(false)
    bindDagWorkerSession(child.sessionId, {
      parentSessionId: 'parent',
      runId: run.id,
      nodeId: node.id,
      attempt: node.attempt,
      workerId,
    })
    expect((await runDagWorkerTool(context as never)).ok).toBe(true)
    expect(dagStore.getRun(run.id)!.nodes[0]!.progress).toBe('Halfway done')
    expect(publishDagRun).toHaveBeenCalledWith('parent')
    unbindDagWorkerSession(child.sessionId)
    expect((await runDagWorkerTool(context as never)).ok).toBe(false)
    state.close()
  })
})
