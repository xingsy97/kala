import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type { LoopBroadcast, ToolDispatcher } from '../loop-types.js'
import { runHostLoop } from '../loop.js'
import { readSessionLog } from '../store/log.js'
import { SessionStore } from '../store/session.js'
import { RestartCoordinator } from '../restart-coordinator.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const broadcast: LoopBroadcast = { onEvent() {}, onApprovalRequired() {}, onError() {} }
const tools: ToolDispatcher = { callTool: async () => ({ ok: true, content: 'tool completed' }), cancelPending() {} }
const compactSummary = `## Objective
- Preserve a running Session across a planned slot handoff.

## User Intent And Constraints
- Continue exactly once without an interrupted response.

## Repository And Runtime State
- The Session is stored in a durable JSONL ledger under the shared Unit root.

## Decisions And Rationale
- Finish compaction before freezing the checkpoint cursor.

## Work Completed
- The pre-cutover conversation reached a durable compaction boundary.

## Open Work
- 1. Continue the turn on the replacement slot.
- 2. Verify the cursor and event identities.
- Blockers: (none)

## Preserved Verbatim
- "continue after compaction"`

describe('planned restart durable handoff', () => {
  it('continues the same durable turn after replacement without interrupted output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-handoff-'))
    roots.push(root)
    const store = new SessionStore(join(root, 'sessions'))
    const config = createConfig({ tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' }, requiresApproval: false }] })
    const record = await store.create({ sessionId: 'handoff-session', config })
    let calls = 0
    const oldLoop = runHostLoop({
      store,
      llm: { name: 'old', async call() { calls += 1; return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'call-read', name: 'read', input: {} }] } } } },
      tools: { ...tools, async callTool() { oldLoop.beginDrain('checkpoint'); return { ok: true, content: 'tool completed' } } },
      broadcast,
    })
    await oldLoop.dispatch(record.sessionId, { kind: 'user_message', text: 'continue after restart' })
    expect(oldLoop.drainSnapshot(record.sessionId)).toMatchObject({ safe: true, checkpointKind: 'before_llm' })

    const replacementStore = new SessionStore(join(root, 'sessions'))
    await replacementStore.load(record.sessionId, { recoverDangling: false })
    const replacementLoop = runHostLoop({
      store: replacementStore,
      llm: { name: 'replacement', async call() { calls += 1; return { message: { role: 'assistant', content: [{ type: 'text', text: 'replacement continued' }] } } } },
      tools,
      broadcast,
    })
    await expect(replacementLoop.resumeSession(record.sessionId)).resolves.toBe(true)
    expect(calls).toBe(2)
    const parsed = await readSessionLog(replacementStore.get(record.sessionId)!.logPath)
    const text = JSON.stringify(parsed.events)
    expect(text).toContain('replacement continued')
    expect(text).not.toContain('[interrupted]')
  })

  it('persists exact-attempt recovery receipts across a second replacement startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-receipt-handoff-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    const store = new SessionStore(join(root, 'sessions'))
    const config = createConfig({ tools: [] })
    const record = await store.create({ sessionId: 'receipt-session', config })
    const loop = runHostLoop({ store, llm: { name: 'never', async call() { return { message: { role: 'assistant', content: [{ type: 'text', text: 'unused' }] } } } }, tools, broadcast })
    const resume = vi.spyOn(loop, 'resumeSession').mockImplementation(async (_sessionId, options) => { await options?.onStarted?.(); return true })
    const marker = {
      attemptId: 'exact-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 1,
      sessions: [{ sessionId: record.sessionId, cursor: record.state.cursor, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn' }],
    }
    await import('node:fs/promises').then((fs) => fs.writeFile(statePath, JSON.stringify(marker)))
    const coordinator = new RestartCoordinator({ store, loop, statePath, emit() {}, closeServer: async () => {}, exitProcess() {} })
    await coordinator.resumeMarkedSessions()
    expect(resume).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(statePath, 'utf8')).recoveryReceipts[record.sessionId]).toMatchObject({ state: 'settled' })
    const second = new RestartCoordinator({ store, loop, statePath, emit() {}, closeServer: async () => {}, exitProcess() {} })
    await second.resumeMarkedSessions()
    expect(resume).toHaveBeenCalledOnce()
  })

  it('recovers an adopted self-deployment continuation from its advanced cursor without replaying a Tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-adopted-handoff-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    const store = new SessionStore(join(root, 'sessions'))
    const config = createConfig({ tools: [{ name: 'inspect', description: 'inspect', inputSchema: { type: 'object' }, requiresApproval: false }] })
    const record = await store.create({ sessionId: 'self-deploy-session', config })
    let toolEffects = 0
    let llmCalls = 0
    const firstLoop = runHostLoop({
      store,
      llm: {
        name: 'candidate-one',
        async call() {
          llmCalls += 1
          return llmCalls === 1
            ? { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'inspect-once', name: 'inspect', input: {} }] } }
            : { message: { role: 'assistant', content: [{ type: 'text', text: 'candidate one settled' }] } }
        },
      },
      tools: { callTool: async () => { toolEffects += 1; return { ok: true, content: 'inspected' } }, cancelPending() {} },
      broadcast,
    })
    await firstLoop.dispatch(record.sessionId, { kind: 'user_message', text: 'deploy and continue' })
    expect(toolEffects).toBe(1)
    expect(store.get(record.sessionId)!.state.status).toBe('done')
    const advancedCursor = store.get(record.sessionId)!.state.cursor
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'self-deployment-attempt', phase: 'completed', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 1,
      sessions: [{ sessionId: record.sessionId, cursor: 1, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn', continuationKey: 'self-deploy-continuation' }],
      recoveryReceipts: { [record.sessionId]: { continuationKey: 'self-deploy-continuation', baselineCursor: 1, state: 'adopted', observedCursor: 1 } },
    } satisfies HostRestartAttempt))

    const replacementStore = new SessionStore(join(root, 'sessions'))
    await replacementStore.load(record.sessionId, { recoverDangling: false })
    const replacementLoop = runHostLoop({
      store: replacementStore,
      llm: { name: 'candidate-two', async call() { llmCalls += 1; return { message: { role: 'assistant', content: [{ type: 'text', text: 'must not run' }] } } } },
      tools: { callTool: async () => { toolEffects += 1; return { ok: true, content: 'duplicate' } }, cancelPending() {} },
      broadcast,
    })
    const resume = vi.spyOn(replacementLoop, 'resumeSession')
    const coordinator = new RestartCoordinator({ store: replacementStore, loop: replacementLoop, statePath, emit() {}, closeServer: async () => {}, exitProcess() {} })
    await coordinator.resumeMarkedSessions()

    expect(resume).not.toHaveBeenCalled()
    expect(toolEffects).toBe(1)
    expect(llmCalls).toBe(2)
    expect(replacementStore.get(record.sessionId)!.state.cursor).toBe(advancedCursor)
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(persisted).toMatchObject({ phase: 'completed', recoveryReceipts: { [record.sessionId]: { state: 'settled', observedCursor: advancedCursor } } })
    expect(JSON.stringify((await readSessionLog(replacementStore.get(record.sessionId)!.logPath)).events)).not.toContain('[interrupted]')
  })

  it('executes a checkpointed pre-dispatch Tool effect exactly once on the replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-tool-effect-handoff-'))
    roots.push(root)
    const store = new SessionStore(join(root, 'sessions'))
    const config = createConfig({ tools: [{ name: 'write', description: 'write', inputSchema: { type: 'object' }, requiresApproval: false }] })
    const record = await store.create({ sessionId: 'tool-effect-session', config })
    let releaseLlm!: () => void
    const llmBlocked = new Promise<void>((resolve) => { releaseLlm = resolve })
    let llmStarted!: () => void
    const started = new Promise<void>((resolve) => { llmStarted = resolve })
    let toolEffects = 0
    const oldLoop = runHostLoop({
      store,
      llm: { name: 'old', async call() { llmStarted(); await llmBlocked; return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'call-write', name: 'write', input: {} }] } } } },
      tools: { callTool: async () => { toolEffects += 1; return { ok: true, content: 'written' } }, cancelPending() {} },
      broadcast,
    })
    const turn = oldLoop.dispatch(record.sessionId, { kind: 'user_message', text: 'write once' })
    await started
    oldLoop.beginDrain('checkpoint')
    releaseLlm()
    await turn
    expect(toolEffects).toBe(0)
    expect(oldLoop.drainSnapshot(record.sessionId)).toMatchObject({ safe: true, checkpointKind: 'before_tool_dispatch' })

    const replacementStore = new SessionStore(join(root, 'sessions'))
    await replacementStore.load(record.sessionId, { recoverDangling: false })
    const replacementLoop = runHostLoop({
      store: replacementStore,
      llm: { name: 'replacement', async call() { return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } } },
      tools: { callTool: async () => { toolEffects += 1; return { ok: true, content: 'written' } }, cancelPending() {} },
      broadcast,
    })
    await expect(replacementLoop.resumeSession(record.sessionId)).resolves.toBe(true)
    await expect(replacementLoop.resumeSession(record.sessionId)).resolves.toBe(false)
    expect(toolEffects).toBe(1)
    const parsed = await readSessionLog(replacementStore.get(record.sessionId)!.logPath)
    expect(parsed.events.filter((entry) => entry.event.kind === 'tool_result' && entry.event.callId === 'call-write')).toHaveLength(1)
    expect(JSON.stringify(parsed.events)).not.toContain('[interrupted]')
  })

  it('preserves a pending Approval across replacement and dispatches its Tool only once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-approval-handoff-'))
    roots.push(root)
    const store = new SessionStore(join(root, 'sessions'))
    const config = createConfig({ tools: [{ name: 'write', description: 'write', inputSchema: { type: 'object' }, requiresApproval: true }] })
    const record = await store.create({ sessionId: 'approval-session', config })
    const oldLoop = runHostLoop({
      store,
      llm: { name: 'old', async call() { return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'approval-write', name: 'write', input: { path: 'one' } }] } } } },
      tools,
      broadcast,
    })
    await oldLoop.dispatch(record.sessionId, { kind: 'user_message', text: 'write after approval' })
    oldLoop.beginDrain('checkpoint')
    expect(oldLoop.drainSnapshot(record.sessionId)).toMatchObject({
      safe: true, checkpointKind: 'waiting_for_approval', status: 'awaiting_approval',
    })

    let toolEffects = 0
    const replacementStore = new SessionStore(join(root, 'sessions'))
    await replacementStore.load(record.sessionId, { recoverDangling: false })
    const replacementLoop = runHostLoop({
      store: replacementStore,
      llm: { name: 'replacement', async call() { return { message: { role: 'assistant', content: [{ type: 'text', text: 'approved write completed' }] } } } },
      tools: { callTool: async () => { toolEffects += 1; return { ok: true, content: 'written once' } }, cancelPending() {} },
      broadcast,
    })
    await expect(replacementLoop.resumeSession(record.sessionId)).resolves.toBe(false)
    expect(replacementStore.get(record.sessionId)!.state).toMatchObject({
      status: 'awaiting_approval',
      pendingCalls: [{ callId: 'approval-write', status: 'awaiting_approval' }],
    })
    expect(toolEffects).toBe(0)

    await replacementLoop.dispatch(record.sessionId, { kind: 'user_approve', callId: 'approval-write' })
    await replacementLoop.dispatch(record.sessionId, { kind: 'user_approve', callId: 'approval-write' })
    expect(toolEffects).toBe(1)
    const parsed = await readSessionLog(replacementStore.get(record.sessionId)!.logPath)
    expect(parsed.events.filter((entry) => entry.event.kind === 'tool_result' && entry.event.callId === 'approval-write')).toHaveLength(1)
    expect(JSON.stringify(parsed.events)).not.toContain('[interrupted]')
  })

  it('settles active Compaction before handoff and continues from a monotonic cursor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-compaction-handoff-'))
    roots.push(root)
    const store = new SessionStore(join(root, 'sessions'))
    const config = createConfig({ tools: [] })
    const record = await store.create({ sessionId: 'compaction-session', config })
    let releaseSummary!: () => void
    const summaryBlocked = new Promise<void>((resolve) => { releaseSummary = resolve })
    let summaryStarted!: () => void
    const started = new Promise<void>((resolve) => { summaryStarted = resolve })
    const oldLoop = runHostLoop({
      store,
      llm: {
        name: 'old',
        async call(input) {
          if (input.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
            summaryStarted()
            await summaryBlocked
            return { message: { role: 'assistant', content: [{ type: 'text', text: compactSummary }] } }
          }
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'old answer before compaction' }] } }
        },
      },
      tools,
      broadcast,
    })
    await oldLoop.dispatch(record.sessionId, { kind: 'user_message', text: 'continue after compaction' })
    const cursorBeforeCompaction = store.get(record.sessionId)!.state.cursor
    const compacting = oldLoop.compact(record.sessionId, 'manual', true)
    await started
    oldLoop.beginDrain('checkpoint')
    expect(oldLoop.drainSnapshot(record.sessionId)).toMatchObject({ safe: false, waiting: 'compaction' })
    releaseSummary()
    await expect(compacting).resolves.toBe(true)
    const checkpoint = oldLoop.drainSnapshot(record.sessionId)
    expect(checkpoint).toMatchObject({ safe: true, checkpointKind: 'before_llm', status: 'thinking' })
    expect(checkpoint.cursor).toBeGreaterThan(cursorBeforeCompaction)

    const replacementStore = new SessionStore(join(root, 'sessions'))
    await replacementStore.load(record.sessionId, { recoverDangling: false })
    expect(replacementStore.get(record.sessionId)!.state.cursor).toBe(checkpoint.cursor)
    const replacementLoop = runHostLoop({
      store: replacementStore,
      llm: { name: 'replacement', async call() { return { message: { role: 'assistant', content: [{ type: 'text', text: 'continued after compacted handoff' }] } } } },
      tools,
      broadcast,
    })
    await expect(replacementLoop.resumeSession(record.sessionId)).resolves.toBe(true)
    const parsed = await readSessionLog(replacementStore.get(record.sessionId)!.logPath)
    expect(parsed.events.map((entry) => entry.seq)).toEqual(parsed.events.map((_, index) => index + 1))
    expect(parsed.events.some((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'compaction')).toBe(true)
    expect(parsed.events.some((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'recovery')).toBe(true)
    expect(replacementStore.get(record.sessionId)!.state.cursor).toBe((checkpoint.cursor ?? 0) + 1)
    expect(JSON.stringify(parsed.events)).not.toContain('[interrupted]')
  })
})
