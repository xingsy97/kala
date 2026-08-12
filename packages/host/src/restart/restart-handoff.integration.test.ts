import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    const resume = vi.spyOn(loop, 'resumeSession').mockResolvedValue(true)
    const marker = {
      attemptId: 'exact-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 1,
      sessions: [{ sessionId: record.sessionId, cursor: 1, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn' }],
    }
    await import('node:fs/promises').then((fs) => fs.writeFile(statePath, JSON.stringify(marker)))
    const coordinator = new RestartCoordinator({ store, loop, statePath, emit() {}, closeServer: async () => {}, exitProcess() {} })
    await coordinator.resumeMarkedSessions()
    expect(resume).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(statePath, 'utf8')).recoveryReceipts[record.sessionId]).toBe('completed')
    const second = new RestartCoordinator({ store, loop, statePath, emit() {}, closeServer: async () => {}, exitProcess() {} })
    await second.resumeMarkedSessions()
    expect(resume).toHaveBeenCalledOnce()
  })
})
