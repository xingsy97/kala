import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConfig, createInitialState } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendEventEntry, writeHeader } from './store/log.js'
import { parseEnhancementCli } from './enhancement-cli.js'
import { auditSessionReliability, replayReliabilityChaos } from './reliability.js'

const READ = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

describe('session reliability audit', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-reliability-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('detects a dangling LLM call from an unfinished thinking session', async () => {
    const sessionId = 's-thinking'
    const logPath = join(dir, 'session.jsonl')
    const cfg = createConfig({ tools: [READ], systemPrompt: 'sys' })
    await writeHeader({ path: logPath, sessionId, config: cfg, initialState: createInitialState({ sessionId, systemPrompt: 'sys' }) })
    await appendEventEntry({ path: logPath, seq: 1, event: { kind: 'user_message', text: 'hi' }, effects: [] })

    const result = await auditSessionReliability({ rootDir: join(dir, 'audit'), sessionLogPath: logPath })

    expect(result.audit.dangling).toBe(true)
    expect(result.audit.danglingKind).toBe('llm_call')
    expect(await readFile(result.auditPath, 'utf8')).toContain('llm_call')
  })

  it('detects dangling dispatched tools and recovery events', async () => {
    const sessionId = 's-tool'
    const logPath = join(dir, 'session.jsonl')
    const cfg = createConfig({ tools: [READ], systemPrompt: 'sys' })
    await writeHeader({ path: logPath, sessionId, config: cfg, initialState: createInitialState({ sessionId, systemPrompt: 'sys' }) })
    await appendEventEntry({ path: logPath, seq: 1, event: { kind: 'user_message', text: 'read' }, effects: [] })
    await appendEventEntry({
      path: logPath,
      seq: 2,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'c1', name: 'read', input: {} }] } },
      effects: [],
    })

    const before = await auditSessionReliability({ rootDir: join(dir, 'audit-before'), sessionLogPath: logPath })
    expect(before.audit.danglingKind).toBe('tool_call')
    expect(before.audit.pendingCalls[0]).toMatchObject({ callId: 'c1', name: 'read' })

    await appendEventEntry({
      path: logPath,
      seq: 3,
      event: { kind: 'tool_result', callId: 'c1', ok: false, content: 'host restarted while call was pending' },
      effects: [],
    })
    const after = await auditSessionReliability({ rootDir: join(dir, 'audit-after'), sessionLogPath: logPath })
    expect(after.audit.recoveryEvents).toBe(1)
  })

  it('replays chaos scenarios across session logs into a compact report', async () => {
    const cfg = createConfig({ tools: [READ], systemPrompt: 'sys' })
    const danglingPath = join(dir, 'dangling.jsonl')
    await writeHeader({ path: danglingPath, sessionId: 's-dangling', config: cfg, initialState: createInitialState({ sessionId: 's-dangling', systemPrompt: 'sys' }) })
    await appendEventEntry({ path: danglingPath, seq: 1, event: { kind: 'user_message', text: 'read' }, effects: [] })
    await appendEventEntry({
      path: danglingPath,
      seq: 2,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'c1', name: 'read', input: {} }] } },
      effects: [],
    })

    const recoveredPath = join(dir, 'recovered.jsonl')
    await writeHeader({ path: recoveredPath, sessionId: 's-recovered', config: cfg, initialState: createInitialState({ sessionId: 's-recovered', systemPrompt: 'sys' }) })
    await appendEventEntry({ path: recoveredPath, seq: 1, event: { kind: 'user_message', text: 'read' }, effects: [] })
    await appendEventEntry({
      path: recoveredPath,
      seq: 2,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'c2', name: 'read', input: {} }] } },
      effects: [],
    })
    await appendEventEntry({
      path: recoveredPath,
      seq: 3,
      event: { kind: 'tool_result', callId: 'c2', ok: false, content: 'host restarted while call was pending' },
      effects: [],
    })

    const result = await replayReliabilityChaos({ rootDir: join(dir, 'chaos'), sessionLogPaths: [danglingPath, recoveredPath] })

    expect(result.report.sessionCount).toBe(2)
    expect(result.report.danglingCount).toBe(2)
    expect(result.report.recoverableCount).toBe(1)
    expect(result.report.recoveryEventCount).toBe(1)
    expect(result.report.danglingByKind.tool_call).toBe(1)
    expect(result.report.danglingByKind.llm_call).toBe(1)
    expect(await readFile(result.reportPath, 'utf8')).toContain('s-dangling')
  })

  it('parses reliability audit CLI commands', () => {
    expect(parseEnhancementCli([
      'enhancement',
      'reliability',
      'audit-session',
      '--session-log',
      's.jsonl',
      '--root-dir',
      'runs/r',
    ])).toMatchObject({ kind: 'reliability-audit-session', rootDir: 'runs/r' })

    expect(parseEnhancementCli([
      'enhancement',
      'reliability',
      'chaos-replay',
      '--session-logs',
      'a.jsonl,b.jsonl',
    ])).toMatchObject({ kind: 'reliability-chaos-replay', sessionLogPaths: ['a.jsonl', 'b.jsonl'] })
  })
})
