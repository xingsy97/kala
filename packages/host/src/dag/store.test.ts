import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { KalaStateStore } from '../store/state-store.js'
import { MAX_DAG_DECISIONS_PER_NODE } from './store.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stateStore(): KalaStateStore {
  const root = mkdtempSync(join(process.cwd(), '.kala-dag-store-'))
  roots.push(root)
  return new KalaStateStore(root)
}

describe('DagStore', () => {
  it('creates distinct immutable runs for successive objectives on one parent session', () => {
    const state = stateStore()
    const store = state.dagStore()
    const first = store.createRun('parent', 'First objective', 'create-1', '2026-01-01T00:00:00.000Z')
    expect(store.createRun('parent', 'First objective', 'create-1').id).toBe(first.id)
    expect(() => store.createRun('parent', 'Changed objective', 'create-1')).toThrow('different run')

    const second = store.createRun('parent', 'Second objective', 'create-2', '2026-01-02T00:00:00.000Z')
    expect(second.id).not.toBe(first.id)
    expect(store.runForSession('parent')?.id).toBe(second.id)
    expect(store.runsForSession('parent').map((run) => run.id)).toEqual([first.id, second.id])
    state.close()
  })

  it('installs an initial graph once, retains v1 history, and cannot reopen a terminal run', () => {
    const state = stateStore()
    const store = state.dagStore()
    const run = store.createRun('parent', 'One shot', 'create')
    const planned = store.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'only',
      nodes: [{ id: 'only', title: 'Only', instructions: 'Finish', estimatedDurationMinutes: 5 }],
      edges: [],
    }, 'plan')
    expect(planned.graphHistory).toHaveLength(1)
    expect(planned.graphHistory?.[0]?.nodes).toEqual([
      expect.objectContaining({ id: 'only', estimatedDurationMinutes: 5 }),
    ])
    expect(() => store.replaceGraph(run.id, {
      expectedGraphVersion: 1,
      resultNodeId: 'destructive',
      nodes: [{ id: 'destructive', title: 'Other', instructions: 'Replace everything' }],
      edges: [],
    }, 'replace')).toThrow('planning run at version 0')

    store.claimReadyNodes(run.id, 'worker', 1, 60_000)
    const completed = store.completeNode(
      run.id,
      'only',
      'worker',
      { status: 'succeeded', result: 'done' },
      'complete',
    )
    expect(completed.status).toBe('completed')
    expect(completed).toMatchObject({
      resultNodeId: 'only',
      result: 'done',
      completedAt: expect.any(String),
    })
    expect(() => store.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'reopen',
      nodes: [{ id: 'reopen', title: 'Reopen', instructions: 'No' }],
      edges: [],
    }, 'reopen')).toThrow('planning run at version 0')
    expect(store.getRun(run.id)?.nodes.map((node) => node.id)).toEqual(['only'])
    expect(store.getRun(run.id)?.graphHistory?.[0]?.nodes.map((node) => node.id)).toEqual(['only'])
    state.close()
  })

  it('atomically replaces one leased node and reconnects its predecessors and successors', () => {
    const state = stateStore()
    const store = state.dagStore()
    const run = store.createRun('parent', 'Expand safely', 'create')
    store.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'after',
      nodes: [
        { id: 'before', title: 'Before', instructions: 'Prepare' },
        { id: 'target', title: 'Target', instructions: 'Expand me' },
        { id: 'after', title: 'After', instructions: 'Consume result' },
      ],
      edges: [
        { source: 'before', target: 'target' },
        { source: 'target', target: 'after' },
      ],
    }, 'plan')
    store.claimReadyNodes(run.id, 'worker', 1, 60_000)
    store.completeNode(run.id, 'before', 'worker', { status: 'succeeded', result: 'ready' }, 'before-done')
    store.claimReadyNodes(run.id, 'worker', 1, 60_000)

    const expanded = store.expandNode(run.id, 'target', 'worker', {
      expectedGraphVersion: 1,
      resultNodeId: 'part-b',
      nodes: [
        { id: 'part-a', title: 'Part A', instructions: 'First part' },
        { id: 'part-b', title: 'Part B', instructions: 'Second part' },
      ],
      edges: [{ source: 'part-a', target: 'part-b' }],
    }, 'expand')
    expect(expanded.graphVersion).toBe(2)
    expect(expanded.resultNodeId).toBe('after')
    expect(expanded.nodes.find((node) => node.id === 'target')).toMatchObject({
      status: 'replaced',
      replacedBy: 'part-a',
    })
    expect(expanded.nodes.filter((node) => node.id.startsWith('part-')).map((node) => node.depth)).toEqual([2, 2])
    expect(expanded.edges.map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      'before->part-a',
      'part-a->part-b',
      'part-b->after',
    ])
    expect(expanded.graphHistory?.map((version) => version.version)).toEqual([1, 2])
    expect(expanded.graphHistory?.[0]?.nodes.map((node) => node.id)).toContain('target')
    expect(expanded.graphHistory?.[1]?.nodes.map((node) => node.id)).not.toContain('target')

    store.claimReadyNodes(run.id, 'worker', 1, 60_000)
    expect(() => store.expandNode(run.id, 'part-a', 'worker', {
      expectedGraphVersion: 1,
      resultNodeId: 'stale',
      nodes: [{ id: 'stale', title: 'Stale', instructions: 'Must fail' }],
      edges: [],
    }, 'stale')).toThrow('version conflict')
    state.close()
  })

  it('tracks progress and attempts while decisions release leases and resume with a new attempt', () => {
    const state = stateStore()
    const store = state.dagStore()
    const run = store.createRun('parent', 'Decide', 'create')
    store.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'choose',
      nodes: [{ id: 'choose', title: 'Choose', instructions: 'Ask for a choice' }],
      edges: [],
    }, 'plan')
    store.claimReadyNodes(run.id, 'worker', 1, 60_000)
    const progressed = store.updateNodeProgress(run.id, 'choose', 'worker', 'Comparing options')
    expect(progressed.nodes[0]?.progress).toBe('Comparing options')
    expect(progressed.events.at(-1)?.message).toContain('Comparing options')

    const decision = store.createDecision({
      id: 'decision',
      runId: run.id,
      nodeId: 'choose',
      workerId: 'worker',
      question: 'Which option?',
      context: 'A durable choice is required.',
      choices: ['A', 'B'],
      allowFreeform: false,
      reason: 'Changes the storage layout',
      riskLevel: 'high',
    })
    expect(decision).toMatchObject({ status: 'pending', reason: 'Changes the storage layout', riskLevel: 'high' })
    expect(store.getRun(run.id)?.attempts?.[0]?.status).toBe('waiting_user')
    expect(() => store.renewLease(run.id, 'choose', 'worker', 60_000)).toThrow('not owned')

    const answered = store.answerDecision(run.id, decision.id, 'A', 'answer')
    expect(answered.nodes[0]?.status).toBe('ready')
    expect(store.latestAnsweredDecision(run.id, 'choose')?.answer).toBe('A')
    const [rerun] = store.claimReadyNodes(run.id, 'worker-2', 1, 60_000)
    expect(rerun?.attempt).toBe(2)
    const completed = store.completeNode(
      run.id,
      'choose',
      'worker-2',
      { status: 'succeeded', result: 'selected A' },
      'complete',
    )
    expect(completed.attempts?.map((attempt) => [attempt.attempt, attempt.status])).toEqual([
      [1, 'waiting_user'],
      [2, 'succeeded'],
    ])
    state.close()
  })

  it('fails a node that exceeds the durable decision safety limit', () => {
    const state = stateStore()
    const store = state.dagStore()
    const run = store.createRun('parent', 'Bounded decisions', 'create')
    store.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'choose',
      nodes: [{ id: 'choose', title: 'Choose', instructions: 'Ask only when necessary' }],
      edges: [],
    }, 'plan')
    store.claimReadyNodes(run.id, 'worker-0', 1, 60_000)
    for (let index = 0; index < MAX_DAG_DECISIONS_PER_NODE; index += 1) {
      const decision = store.createDecision({
        id: `decision-${index}`,
        runId: run.id,
        nodeId: 'choose',
        workerId: `worker-${index}`,
        question: `Question ${index}`,
        context: '',
        choices: [],
        allowFreeform: true,
      })
      store.answerDecision(run.id, decision.id, `answer-${index}`, `answer-${index}`)
      store.claimReadyNodes(run.id, `worker-${index + 1}`, 1, 60_000)
    }

    expect(() => store.createDecision({
      id: 'decision-over-limit',
      runId: run.id,
      nodeId: 'choose',
      workerId: `worker-${MAX_DAG_DECISIONS_PER_NODE}`,
      question: 'One question too many',
      context: '',
      choices: [],
      allowFreeform: true,
    })).toThrow(`${MAX_DAG_DECISIONS_PER_NODE}-decision safety limit`)
    const failed = store.getRun(run.id)!
    expect(failed.status).toBe('failed')
    expect(failed.nodes[0]).toMatchObject({
      status: 'failed',
      error: `DAG node exceeded the ${MAX_DAG_DECISIONS_PER_NODE}-decision safety limit`,
    })
    expect(failed.attempts?.at(-1)?.status).toBe('failed')
    state.close()
  })

  it('cancels descendants of a failed node but lets independent branches finish before settling', () => {
    const state = stateStore()
    const store = state.dagStore()
    const run = store.createRun('parent', 'Branching work', 'create')
    store.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'blocked',
      nodes: [
        { id: 'fails', title: 'Fails', instructions: 'Fail' },
        { id: 'blocked', title: 'Blocked', instructions: 'Cannot run' },
        { id: 'independent', title: 'Independent', instructions: 'Still runs' },
      ],
      edges: [{ source: 'fails', target: 'blocked' }],
    }, 'plan')
    expect(store.claimReadyNodes(run.id, 'worker', 3, 60_000).map((node) => node.id)).toEqual([
      'fails',
      'independent',
    ])
    const afterFailure = store.completeNode(
      run.id,
      'fails',
      'worker',
      { status: 'failed', error: 'boom' },
      'fail',
    )
    expect(afterFailure.status).toBe('running')
    expect(afterFailure.nodes.find((node) => node.id === 'blocked')?.status).toBe('cancelled')
    expect(afterFailure.nodes.find((node) => node.id === 'independent')?.status).toBe('running')

    const settled = store.completeNode(
      run.id,
      'independent',
      'worker',
      { status: 'succeeded', result: 'done' },
      'independent-done',
    )
    expect(settled.status).toBe('failed')
    expect(settled.error).toBe('Blocked by failed dependency')
    expect(settled.events.some((event) => event.message === 'Node cancelled because a dependency failed')).toBe(true)
    expect(settled.events.at(-1)?.message).toBe('DAG run failed')
    state.close()
  })

  it('migrates version 2 state without losing its existing run or session history', () => {
    const root = mkdtempSync(join(process.cwd(), '.kala-dag-v2-'))
    roots.push(root)
    const database = new DatabaseSync(join(root, 'state.sqlite'))
    database.exec(`
      CREATE TABLE dag_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL UNIQUE,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        graph_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE dag_nodes (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES dag_runs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        status TEXT NOT NULL,
        depth INTEGER NOT NULL,
        write_scopes TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        child_session_id TEXT,
        progress TEXT,
        result TEXT,
        error TEXT,
        replaced_by TEXT,
        started_at TEXT,
        completed_at TEXT,
        PRIMARY KEY (run_id, id)
      );
      INSERT INTO dag_runs VALUES ('old-run', 'parent', 'Old objective', 'running', 1, '2025-01-01', '2025-01-01');
      INSERT INTO dag_nodes (
        id, run_id, title, instructions, status, depth, write_scopes, attempt
      ) VALUES ('old-node', 'old-run', 'Old node', 'Preserve me', 'ready', 0, '[]', 0);
      PRAGMA user_version = 2;
    `)
    database.close()

    const state = new KalaStateStore(root)
    const store = state.dagStore()
    expect(store.getRun('old-run')).toMatchObject({
      parentSessionId: 'parent',
      objective: 'Old objective',
      graphHistory: [{ version: 1, nodes: [expect.objectContaining({ id: 'old-node' })] }],
    })
    expect(store.createRun('parent', 'New objective', 'new-run').id).not.toBe('old-run')
    expect(store.runsForSession('parent')).toHaveLength(2)
    state.close()
  })

  it('rejects an operation id reused for a different kind or run', () => {
    const state = stateStore()
    const store = state.dagStore()
    const run = store.createRun('parent-a', 'First', 'shared-operation')
    expect(() => store.installGraph(run.id, {
      expectedGraphVersion: 0,
      resultNodeId: 'node',
      nodes: [{ id: 'node', title: 'Node', instructions: 'work' }],
      edges: [],
    }, 'shared-operation')).toThrow('already used for a different operation')
    expect(() => store.createRun('parent-b', 'Second', 'shared-operation')).toThrow('different run')
    state.close()
  })
})
