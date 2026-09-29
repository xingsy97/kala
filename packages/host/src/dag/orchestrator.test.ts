import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfig } from '@agent-kernel/kernel'

import { SessionStore } from '../store/session.js'
import { KalaStateStore } from '../store/state-store.js'
import { DagOrchestrator, normalizeWorkerResult, workerToolActivity } from './orchestrator.js'
import { DAG_WORKER_TOOLS, runDagWorkerTool } from './worker-tool.js'

const workerConfig = createConfig({
  systemPrompt: 'standard chat worker',
  tools: [
    { name: 'read_file', description: 'Read', inputSchema: { type: 'object' }, requiresApproval: false },
    ...DAG_WORKER_TOOLS,
  ],
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DagOrchestrator', () => {
  it('runs dependency layers and durably links child Sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-dag-orchestrator-'))
    roots.push(root)
    const sessions = new SessionStore(join(root, 'sessions'))
    const parent = await sessions.create({
      sessionId: 'parent',
      executionMode: 'dag',
      config: createConfig({ tools: [] }),
    })
    const state = new KalaStateStore(join(root, 'state'))
    const dagStore = state.dagStore()
    const run = dagStore.createRun(parent.sessionId, 'Build, package, then test', 'create')
    dagStore.replaceGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'test',
      nodes: [
        { id: 'build', title: 'Build', instructions: 'build', writeScopes: ['src'] },
        { id: 'package', title: 'Package', instructions: 'package', writeScopes: ['dist'] },
        { id: 'test', title: 'Test', instructions: 'test', writeScopes: ['tests'] },
      ],
      edges: [{ source: 'build', target: 'package' }, { source: 'package', target: 'test' }],
    }, 'graph')
    const calls: string[] = []
    const prompts: string[] = []
    const runNode = vi.fn(async (
      _deps: unknown,
      _parentId: string,
      effect: { callId: string; input: Record<string, unknown> },
      _aborts: unknown,
      _loop: unknown,
      _runtime: unknown,
      options?: { configOverride?: ReturnType<typeof createConfig>; onChildCreated?: (child: Awaited<ReturnType<typeof sessions.create>>) => void | Promise<void> },
    ) => {
      calls.push(effect.callId)
      prompts.push(String(effect.input.prompt))
      const child = await sessions.create({
        sessionId: `child-${effect.callId}`,
        parentSessionId: parent.sessionId,
        config: options?.configOverride ?? createConfig({ tools: [] }),
      })
      await options?.onChildCreated?.(child)
      return { ok: true, content: `done:${effect.callId.split(':').at(-2)}` }
    })
    const onError = vi.fn()
    const orchestrator = new DagOrchestrator(
      dagStore,
      { store: sessions, dagWorkerConfig: () => workerConfig, publishDagRun: vi.fn(), broadcast: { onError } } as never,
      {} as never,
      undefined,
      runNode as never,
    )

    orchestrator.schedule(parent.sessionId)
    await waitFor(
      () => dagStore.getRun(run.id)?.status === 'completed' || onError.mock.calls.length > 0,
      () => JSON.stringify({ run: dagStore.getRun(run.id), calls, errors: onError.mock.calls }),
    )
    expect(onError).not.toHaveBeenCalled()

    const completed = dagStore.getRun(run.id)!
    expect(completed.result).toBe('done:test')
    expect(calls.map((callId) => callId.split(':').at(-2))).toEqual(['build', 'package', 'test'])
    expect(prompts[2]).toContain('Top-level objective: Build, package, then test')
    expect(prompts[2]).toContain('- package (Package): done:package')
    expect(prompts[2]).toContain('- build (Build): done:build')
    expect(completed.nodes.map((node) => ({
      id: node.id,
      status: node.status,
      childSessionId: node.childSessionId,
    }))).toEqual([
      { id: 'build', status: 'succeeded', childSessionId: `child-${calls[0]}` },
      { id: 'package', status: 'succeeded', childSessionId: `child-${calls[1]}` },
      { id: 'test', status: 'succeeded', childSessionId: `child-${calls[2]}` },
    ])
    const child = sessions.get(completed.nodes[0]!.childSessionId!)!
    expect(child.config.systemPrompt).toBe('standard chat worker')
    expect(child.config.tools.map((tool) => tool.name)).toContain('dag_report_progress')
    expect(child.config.tools.map((tool) => tool.name)).not.toContain('dag_plan')
    expect(child.config.tools.map((tool) => tool.name)).not.toContain('agent')
    await orchestrator.close()
    state.close()
  })

  it('stores only the worker result body for the user-facing Run result', () => {
    expect(normalizeWorkerResult('<sub_agent><result>\n# Answer\n\nDone.\n</result></sub_agent>')).toBe('# Answer\n\nDone.')
    expect(normalizeWorkerResult('plain result')).toBe('plain result')
  })

  it('classifies durable worker tool activity without retaining credential values', () => {
    expect(workerToolActivity([{
      content: [
        { type: 'tool_call', callId: 'read', name: 'read_file', input: { path: 'README.md' } },
        { type: 'tool_result', callId: 'read', ok: true, content: 'contents' },
        { type: 'tool_call', callId: 'install', name: 'shell', input: { command: 'API_TOKEN=secret npm install' } },
        { type: 'tool_result', callId: 'install', ok: false, content: 'denied' },
        { type: 'tool_call', callId: 'header', name: 'shell', input: { command: 'curl -H "Authorization: Bearer secret-value" https://example.test' } },
        { type: 'tool_call', callId: 'flag', name: 'shell', input: { command: 'npm login --password "secret value"' } },
      ],
    }])).toEqual([
      expect.objectContaining({ callId: 'read', category: 'read', status: 'succeeded', summary: 'README.md' }),
      expect.objectContaining({ callId: 'install', category: 'install', status: 'failed', summary: 'API_TOKEN=[REDACTED] npm install' }),
      expect.objectContaining({ callId: 'header', category: 'network', summary: 'curl -H "Authorization: [REDACTED]" https://example.test' }),
      expect.objectContaining({ callId: 'flag', category: 'shell', summary: 'npm login --password [REDACTED]' }),
    ])
  })

  it('does not execute overlapping write scopes concurrently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-dag-orchestrator-'))
    roots.push(root)
    const sessions = new SessionStore(join(root, 'sessions'))
    const parent = await sessions.create({
      sessionId: 'parent',
      executionMode: 'dag',
      config: createConfig({ tools: [] }),
    })
    const state = new KalaStateStore(join(root, 'state'))
    const dagStore = state.dagStore()
    const run = dagStore.createRun(parent.sessionId, 'Parallel work', 'create')
    dagStore.replaceGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'two',
      nodes: [
        { id: 'one', title: 'One', instructions: 'one', writeScopes: ['src'] },
        { id: 'two', title: 'Two', instructions: 'two', writeScopes: ['src/api'] },
      ],
      edges: [],
    }, 'graph')
    let concurrent = 0
    let peak = 0
    const runNode = vi.fn(async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 20))
      concurrent -= 1
      return { ok: true, content: 'done' }
    })
    const onError = vi.fn()
    const orchestrator = new DagOrchestrator(
      dagStore,
      { store: sessions, dagWorkerConfig: () => workerConfig, broadcast: { onError } } as never,
      {} as never,
      undefined,
      runNode as never,
    )

    orchestrator.schedule(parent.sessionId)
    await waitFor(
      () => dagStore.getRun(run.id)?.status === 'completed' || onError.mock.calls.length > 0,
      () => JSON.stringify({ run: dagStore.getRun(run.id), calls: runNode.mock.calls.length, errors: onError.mock.calls }),
    )
    expect(onError).not.toHaveBeenCalled()
    expect(runNode).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
    await orchestrator.close()
    state.close()
  })

  it.each(['decision', 'replacement'] as const)('does not complete a node after a worker %s', async (mutation) => {
    const root = mkdtempSync(join(tmpdir(), 'kala-dag-orchestrator-'))
    roots.push(root)
    const sessions = new SessionStore(join(root, 'sessions'))
    const parent = await sessions.create({ sessionId: 'parent', executionMode: 'dag', config: createConfig({ tools: [] }) })
    const state = new KalaStateStore(join(root, 'state'))
    const dagStore = state.dagStore()
    const run = dagStore.createRun(parent.sessionId, 'Need input', 'create')
    dagStore.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'work',
      nodes: [{ id: 'work', title: 'Work', instructions: 'work' }],
      edges: [],
    }, 'graph')
    let invocations = 0
    const prompts: string[] = []
    const runNode = vi.fn(async (
      deps: never,
      _parentId: string,
      effect: { callId: string; input: Record<string, unknown> },
      _aborts: unknown,
      _loop: unknown,
      _runtime: unknown,
      options: { configOverride: ReturnType<typeof createConfig>; onChildCreated: (child: Awaited<ReturnType<typeof sessions.create>>) => Promise<void> },
    ) => {
      invocations += 1
      prompts.push(String(effect.input.prompt))
      const child = await sessions.create({
        sessionId: `child-${mutation}-${invocations}`,
        parentSessionId: parent.sessionId,
        parentCallId: effect.callId,
        config: options.configOverride,
      })
      await options.onChildCreated(child)
      if (mutation === 'decision' && invocations > 1) return { ok: true, content: 'continued with answer' }
      const toolResult = await runDagWorkerTool({
        deps,
        sessionId: child.sessionId,
        effect: mutation === 'decision'
          ? {
              kind: 'call_tool',
              callId: 'decision-call',
              name: 'dag_request_decision',
              input: { question: 'Choose?', context: 'Needed', choices: ['A'], allow_freeform: false },
            }
          : {
              kind: 'call_tool',
              callId: 'replace-call',
              name: 'dag_replace_self',
              input: {
                entry_node_id: 'part',
                result_node_id: 'part',
                expected_graph_version: 1,
                nodes: [{ id: 'part', title: 'Part', instructions: 'do part' }],
                edges: [],
              },
            },
        aborts: new Map(),
        plannedContinuation: false,
      })
      expect(toolResult.ok).toBe(true)
      return { ok: true, content: 'must not become the node result' }
    })
    const onError = vi.fn()
    const orchestrator = new DagOrchestrator(
      dagStore,
      { store: sessions, dagStore, dagWorkerConfig: () => workerConfig, publishDagRun: vi.fn(), broadcast: { onError } } as never,
      {} as never,
      undefined,
      runNode as never,
    )

    orchestrator.schedule(parent.sessionId)
    await waitFor(() => {
      const status = dagStore.getRun(run.id)?.nodes.find((node) => node.id === 'work')?.status
      return status === (mutation === 'decision' ? 'waiting_user' : 'replaced')
    }, () => JSON.stringify(dagStore.getRun(run.id)))
    const node = dagStore.getRun(run.id)!.nodes.find((candidate) => candidate.id === 'work')!
    expect(node.result).toBeUndefined()
    if (mutation === 'decision') {
      const decision = dagStore.getRun(run.id)!.decisions[0]!
      dagStore.answerDecision(run.id, decision.id, 'A', 'answer')
      orchestrator.schedule(parent.sessionId)
      await waitFor(() => dagStore.getRun(run.id)?.status === 'completed', () => JSON.stringify(dagStore.getRun(run.id)))
      expect(prompts[1]).toContain('Latest answered decision:')
      expect(prompts[1]).toContain('Answer: A')
      expect(dagStore.getRun(run.id)!.nodes[0]!.childSessionId).toBe('child-decision-2')
    }
    await orchestrator.close()
    state.close()
  })
})

async function waitFor(predicate: () => boolean, details: () => string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for DAG state: ${details()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
