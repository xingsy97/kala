import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConfig, createInitialState } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli } from './ops-cli.js'
import { classifyReliability } from './reliability-classify.js'
import type { HeartbeatRecord } from './reliability-supervisor.js'
import { appendEventEntry, writeHeader } from './store/log.js'

const READ = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

describe('reliability classify binder', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-reliability-classify-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function writeSessionWithPendingTool(): Promise<string> {
    const logPath = join(dir, 'session.jsonl')
    const sessionId = 'session-A'
    const cfg = createConfig({ tools: [READ], systemPrompt: 'sys' })
    await writeHeader({ path: logPath, sessionId, config: cfg, initialState: createInitialState({ sessionId, systemPrompt: 'sys' }) })
    await appendEventEntry({ path: logPath, seq: 1, event: { kind: 'user_message', text: 'read' }, effects: [] })
    await appendEventEntry({
      path: logPath,
      seq: 2,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'c1', name: 'read', input: {} }] } },
      effects: [],
    })
    return logPath
  }

  async function writeHeartbeat(records: readonly Omit<HeartbeatRecord, 'timestamp'>[], baseIsoTime: string): Promise<string> {
    const path = join(dir, 'heartbeat.jsonl')
    const base = Date.parse(baseIsoTime)
    const body = records
      .map((record, index) => JSON.stringify({ timestamp: new Date(base + index * 1000).toISOString(), ...record }))
      .join('\n')
    await writeFile(path, `${body}\n`, 'utf8')
    return path
  }

  it('flags a wedged process when pending calls exist and heartbeat is old', async () => {
    const sessionLogPath = await writeSessionWithPendingTool()
    const heartbeatPath = await writeHeartbeat(
      [{ processId: 'pid-1', sessionId: 'session-A', status: 'thinking', pendingCallIds: ['c1'] }],
      '2026-07-09T12:00:00.000Z',
    )

    const now = Date.parse('2026-07-09T12:05:00.000Z')
    const result = await classifyReliability({
      rootDir: join(dir, 'crash'),
      sessionLogPath,
      heartbeatPath,
      wedgedThresholdMs: 60_000,
      now: () => now,
    })

    expect(result.report.suspectedFailure).toBe('wedged')
    expect(result.report.sessionId).toBe('session-A')
    expect(result.report.pendingCalls).toBe(1)
    expect(result.report.lastHeartbeat?.status).toBe('thinking')
    const persisted = JSON.parse(await readFile(result.reportPath, 'utf8'))
    expect(persisted.suspectedFailure).toBe('wedged')
  })

  it('reports clean_shutdown when the last heartbeat says shutting_down', async () => {
    const sessionLogPath = await writeSessionWithPendingTool()
    const heartbeatPath = await writeHeartbeat(
      [
        { processId: 'pid-1', sessionId: 'session-A', status: 'thinking' },
        { processId: 'pid-1', sessionId: 'session-A', status: 'shutting_down' },
      ],
      '2026-07-09T12:00:00.000Z',
    )

    const result = await classifyReliability({
      rootDir: join(dir, 'crash'),
      sessionLogPath,
      heartbeatPath,
      now: () => Date.parse('2026-07-09T12:00:05.000Z'),
    })

    expect(result.report.suspectedFailure).toBe('clean_shutdown')
  })

  it('classifies missing heartbeat as restart_before_result', async () => {
    const sessionLogPath = await writeSessionWithPendingTool()
    const result = await classifyReliability({
      rootDir: join(dir, 'crash'),
      sessionLogPath,
      heartbeatPath: join(dir, 'missing.jsonl'),
    })
    expect(result.report.suspectedFailure).toBe('restart_before_result')
  })

  it('parses the CLI verb into a reliability-classify command', () => {
    expect(
      parseEnhancementCli([
        'enhancement',
        'reliability',
        'classify',
        '--session-log',
        'sessions/session-A.jsonl',
        '--heartbeat',
        'runs/reliability/heartbeat.jsonl',
        '--root-dir',
        'runs/reliability/classify',
        '--wedged-threshold-ms',
        '30000',
      ]),
    ).toMatchObject({
      kind: 'reliability-classify',
      sessionLogPath: 'sessions/session-A.jsonl',
      heartbeatPath: 'runs/reliability/heartbeat.jsonl',
      rootDir: 'runs/reliability/classify',
      wedgedThresholdMs: 30000,
    })
  })
})
