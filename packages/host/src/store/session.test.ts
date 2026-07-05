/**
 * SessionStore tests. Focused on the concurrent-create race that made
 * two dashboard+executor sockets land two different log files on disk for
 * the same sessionId (see docs/adversarial-review-2026-07-04.md, B8).
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'

import { SessionStore } from './session.js'
import { appendEventEntry, readSessionLog, writeHeader } from './log.js'
import { createInitialState } from '@agent-kernel/kernel'

const config = createConfig({ tools: [], systemPrompt: 'sys' })

describe('SessionStore.ensure', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-store-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns the same record for concurrent callers and writes ONE log file', async () => {
    // The race: dashboard + executor sockets arrive in the same tick, both
    // find no cached record, both fail to load, both call create() with a
    // filename that embeds `new Date().toISOString()`  -  producing TWO
    // distinct files on disk and TWO in-memory records (last write wins).
    const store = new SessionStore(dir)
    const sessionId = 'sess-race'

    const [a, b, c] = await Promise.all([
      store.ensure({ sessionId, defaultConfig: config }),
      store.ensure({ sessionId, defaultConfig: config }),
      store.ensure({ sessionId, defaultConfig: config }),
    ])

    expect(a.record).toBe(b.record)
    expect(b.record).toBe(c.record)
    expect(store.get(sessionId)).toBe(a.record)
    // Exactly one caller in a concurrent race should observe `created: true`.
    expect([a.created, b.created, c.created].filter(Boolean)).toHaveLength(1)

    // Most important assertion: exactly one log file on disk. Before the
    // fix this was 3.
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(new RegExp(`_${sessionId}\\.jsonl$`))
  })

  it('serialises ensure vs load for the same id', async () => {
    // A caller who does `load` while `ensure` is mid-create must observe
    // the same record  -  not throw "unknown session".
    const store = new SessionStore(dir)
    const sessionId = 'sess-mixed'

    const p1 = store.ensure({ sessionId, defaultConfig: config })
    const p2 = store.load(sessionId)

    const [a, b] = await Promise.all([p1, p2])
    expect(a.record).toBe(b)
  })

  it('returns the cached record on subsequent calls without touching disk', async () => {
    const store = new SessionStore(dir)
    const first = await store.ensure({
      sessionId: 'sess-cached',
      defaultConfig: config,
    })
    expect(first.created).toBe(true)
    const filesBefore = readdirSync(dir).length
    const again = await store.ensure({
      sessionId: 'sess-cached',
      defaultConfig: config,
    })
    expect(again.record).toBe(first.record)
    expect(again.created).toBe(false)
    expect(readdirSync(dir).length).toBe(filesBefore)
  })

  it('reloads a persisted session from disk instead of creating anew', async () => {
    // First instance creates the log; a fresh store rehydrates from disk.
    const store1 = new SessionStore(dir)
    const rec1 = await store1.ensure({
      sessionId: 'sess-persist',
      defaultConfig: config,
    })
    expect(rec1.created).toBe(true)
    const filesAfterFirst = readdirSync(dir).length
    expect(filesAfterFirst).toBe(1)

    const store2 = new SessionStore(dir)
    const rec2 = await store2.ensure({
      sessionId: 'sess-persist',
      defaultConfig: config,
    })
    expect(rec2.record.sessionId).toBe(rec1.record.sessionId)
    expect(rec2.created).toBe(false)
    // No second file was created.
    expect(readdirSync(dir).length).toBe(1)
  })
})

describe('SessionStore crash recovery', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-crash-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('closes a session that was executing_tools when the host died', async () => {
    // Seed a log by hand: header + user_message + assistant tool_call, then
    // NO tool_result  -  simulating the host crashing after dispatching the
    // tool call. On next load the store must synthesize a failure result.
    const sessionId = 'sess-crash-exec'
    const path = join(dir, `2026-07-05T00-00-00.000Z_${sessionId}.jsonl`)
    const tool = {
      name: 'read',
      description: 'read',
      inputSchema: { type: 'object' },
      requiresApproval: false,
    } as const
    const cfg = createConfig({ tools: [tool], systemPrompt: 'sys' })
    const initial = createInitialState({ sessionId, systemPrompt: 'sys' })
    await writeHeader({ path, sessionId, config: cfg, initialState: initial })
    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'read x' },
      effects: [],
    })
    await appendEventEntry({
      path,
      seq: 2,
      event: {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'read',
              input: { path: '/x' },
            },
          ],
        },
      },
      effects: [],
    })

    const store = new SessionStore(dir)
    const rec = await store.load(sessionId)

    // Session is settled again  -  the reducer flowed tool_result  -  thinking
    // (because pendingCalls emptied out)  -  but with no follow-up LLM call
    // to make, dispatch never happens; the load-time fold leaves status
    // wherever the synthetic events land it. What matters is: pendingCalls
    // is empty and status is not 'awaiting_approval' / 'executing_tools'.
    expect(rec.state.pendingCalls).toEqual([])
    expect(rec.state.status).not.toBe('awaiting_approval')
    expect(rec.state.status).not.toBe('executing_tools')

    // Log was appended: seq 3 is the synthetic tool_result.
    const parsed = await readSessionLog(path)
    const lastEvent = parsed.events[parsed.events.length - 1]!
    expect(lastEvent.event.kind).toBe('tool_result')
    if (lastEvent.event.kind === 'tool_result') {
      expect(lastEvent.event.ok).toBe(false)
      expect(lastEvent.event.content).toMatch(/host restarted/)
    }
  })

  it('closes a session that was awaiting_approval when the host died', async () => {
    // Same as above but the tool required approval, so on crash the pending
    // call had status='awaiting_approval'. Recovery must first approve, then
    // fail, so the reducer accepts the tool_result.
    const sessionId = 'sess-crash-approve'
    const path = join(dir, `2026-07-05T00-00-01.000Z_${sessionId}.jsonl`)
    const tool = {
      name: 'shell',
      description: 'shell',
      inputSchema: { type: 'object' },
      requiresApproval: true,
    } as const
    const cfg = createConfig({ tools: [tool], systemPrompt: 'sys' })
    const initial = createInitialState({ sessionId, systemPrompt: 'sys' })
    await writeHeader({ path, sessionId, config: cfg, initialState: initial })
    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'shell rm -rf' },
      effects: [],
    })
    await appendEventEntry({
      path,
      seq: 2,
      event: {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'c2',
              name: 'shell',
              input: { cmd: 'ls' },
            },
          ],
        },
      },
      effects: [],
    })

    const store = new SessionStore(dir)
    const rec = await store.load(sessionId)

    expect(rec.state.pendingCalls).toEqual([])
    expect(rec.state.status).not.toBe('awaiting_approval')

    const parsed = await readSessionLog(path)
    // Two synthetic events appended: approve + failed tool_result.
    expect(parsed.events).toHaveLength(4)
    expect(parsed.events[2]!.event.kind).toBe('user_approve')
    expect(parsed.events[3]!.event.kind).toBe('tool_result')
  })

  it('closes a session that was mid-stream (thinking) when the host died', async () => {
    // Host issued call_llm and died before the response returned. On disk we
    // see user_message  -  status=thinking  -  nothing else. Without recovery the
    // session sits in `thinking` forever: reducer refuses new user_message
    // from that state, so the client can never continue. Load must synthesize
    // an assistant llm_response with a [interrupted] marker so the session
    // becomes `done` and the dashboard sees the closure event.
    const sessionId = 'sess-crash-thinking'
    const path = join(dir, `2026-07-05T00-00-02.000Z_${sessionId}.jsonl`)
    const cfg = createConfig({ tools: [], systemPrompt: 'sys' })
    const initial = createInitialState({ sessionId, systemPrompt: 'sys' })
    await writeHeader({ path, sessionId, config: cfg, initialState: initial })
    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'hello' },
      effects: [{ kind: 'call_llm', messages: [], tools: [] }],
    })

    const store = new SessionStore(dir)
    const rec = await store.load(sessionId)

    expect(rec.state.status).toBe('done')
    expect(rec.state.pendingCalls).toEqual([])

    const parsed = await readSessionLog(path)
    expect(parsed.events).toHaveLength(2)
    const recovery = parsed.events[1]!.event
    expect(recovery.kind).toBe('llm_response')
    if (recovery.kind === 'llm_response') {
      expect(recovery.message.role).toBe('assistant')
      const text = recovery.message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('')
      expect(text).toBe('[interrupted]')
    }
  })
})
