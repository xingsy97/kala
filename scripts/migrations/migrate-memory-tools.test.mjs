import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

describe('migrate-memory-tools', () => {
  let dir

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('collapses legacy memory tool schemas and tool calls', () => {
    dir = mkdtempSync(join(tmpdir(), 'ak-memory-migrate-'))
    const path = join(dir, '2026-07-06T00-00-00.000Z_sess.jsonl')
    const header = {
      kind: 'header',
      seq: 0,
      ts: '2026-07-06T00:00:00.000Z',
      sessionId: 'sess',
      formatVersion: 1,
      kernelVersion: '@agent-kernel/kernel@0.0.0',
      config: {
        tools: [
          { name: 'read', description: 'read', inputSchema: {}, requiresApproval: false },
          { name: 'memory_read', description: 'read memory', inputSchema: {}, requiresApproval: false },
          { name: 'memory_write', description: 'write memory', inputSchema: {}, requiresApproval: false },
          { name: 'memory_delete', description: 'delete memory', inputSchema: {}, requiresApproval: false },
        ],
      },
      initialState: {
        sessionId: 'sess',
        messages: [],
        pendingCalls: [],
        status: 'idle',
        usage: { inputTokens: 0, outputTokens: 0 },
        cursor: 0,
      },
    }
    const event = {
      kind: 'event',
      seq: 1,
      ts: '2026-07-06T00:00:01.000Z',
      event: {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'c1', name: 'memory_write', input: { scope: 'session', key: 'k', content: 'v' } },
          ],
        },
      },
      effects: [
        { kind: 'call_tool', callId: 'c1', name: 'memory_write', input: { scope: 'session', key: 'k', content: 'v' } },
        { kind: 'call_llm', messages: [], tools: header.config.tools },
      ],
    }
    writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(event)}\n`, 'utf8')

    execFileSync(process.execPath, [join(process.cwd(), 'scripts/migrations/migrate-memory-tools.mjs'), dir], {
      cwd: process.cwd(),
      stdio: 'pipe',
    })

    const [nextHeader, nextEvent] = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(nextHeader.config.tools.map((tool) => tool.name)).toEqual(['read', 'memory'])
    expect(nextEvent.event.message.content[0]).toMatchObject({
      name: 'memory',
      input: { operation: 'write', scope: 'session', key: 'k', content: 'v' },
    })
    expect(nextEvent.effects[0]).toMatchObject({
      kind: 'call_tool',
      name: 'memory',
      input: { operation: 'write' },
    })
    expect(nextEvent.effects[1].tools.map((tool) => tool.name)).toEqual(['read', 'memory'])
  })
})
