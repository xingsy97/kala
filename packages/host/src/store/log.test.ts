/**
 * Persistence layer: JSONL log round-trip and crash-recovery cases.
 *
 * We care especially about the "process died mid-write" scenario since it's
 * the only way a real deployment produces a malformed log file: `appendFile`
 * is atomic per-call in Node.js, but a SIGKILL between the write() syscall
 * and the newline byte still leaves a partial line on disk.
 */

import { mkdtempSync, readlinkSync, readdirSync, rmSync } from 'node:fs'
import { appendFile, readFile, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentConfig, AgentState } from '@agent-kernel/kernel'

import {
  appendEventEntry,
  appendRuntimeMetadataEntry,
  appendSnapshotEntry,
  findLatestRuntimeMetadata,
  findPersistedToolResult,
  findSessionOperation,
  readSessionHistory,
  readSessionHeader,
  readLastSessionSnapshot,
  readSessionLog,
  readSessionState,
  writeHeader,
} from './log.js'

const config: AgentConfig = {
  model: 'test-model',
  tools: [],
  maxSteps: 10,
}

const initialState: AgentState = {
  status: 'idle',
  messages: [],
  cursor: 0,
  pendingCalls: [],
  approvals: {},
}

describe('readSessionLog', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-log-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads only the header when later log content is malformed', async () => {
    const path = join(dir, 'header-only.jsonl')
    await writeHeader({ path, sessionId: 'child', config, initialState, parentSessionId: 'parent' })
    await appendFile(path, '{"kind":"event","truncated":', 'utf8')

    await expect(readSessionHeader(path)).resolves.toMatchObject({
      kind: 'header',
      sessionId: 'child',
      parentSessionId: 'parent',
    })
  })

  it.runIf(process.platform === 'linux')('closes the header read stream after returning the first line', async () => {
    const path = join(dir, 'header-fd.jsonl')
    await writeHeader({ path, sessionId: 'child', config, initialState, parentSessionId: 'parent' })

    for (let index = 0; index < 100; index++) await readSessionHeader(path)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const openCopies = readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`) === path
      } catch {
        return false
      }
    })
    expect(openCopies).toEqual([])
  })

  it('loads history without materializing repeated external runtime snapshots', async () => {
    const path = join(dir, 'history-only.jsonl')
    await writeHeader({ path, sessionId: 'external', agentRuntime: 'copilot', config, initialState })
    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'hello' },
      effects: [],
    })
    await appendFile(path, `${JSON.stringify({ kind: 'snapshot', seq: 2, ts: new Date().toISOString(), state: { ...initialState, cursor: 2, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1_000_000) }] }] } })}\n`, 'utf8')
    await appendRuntimeMetadataEntry(path, { sessionId: 'external', action: 'test', payload: { ok: true } })

    await expect(readSessionHistory(path)).rejects.toThrow(/refuses to fully read external Runtime session external/)
    const parsed = await readSessionHistory(path, { allowExternalRuntime: true })

    expect(parsed.events.map((entry) => entry.event.kind)).toEqual(['user_message'])
    expect(parsed.runtimeMetadata.map((entry) => entry.action)).toEqual(['test'])
  })

  it('loads state using only the latest external runtime snapshot', async () => {
    const path = join(dir, 'state-only.jsonl')
    await writeHeader({ path, sessionId: 'external', agentRuntime: 'copilot', config, initialState })
    await appendFile(path, `${JSON.stringify({ kind: 'snapshot', seq: 1, ts: new Date().toISOString(), state: { ...initialState, cursor: 1, status: 'thinking' } })}\n`, 'utf8')
    await appendFile(path, `${JSON.stringify({ kind: 'snapshot', seq: 2, ts: new Date().toISOString(), state: { ...initialState, cursor: 2, status: 'done' } })}\n`, 'utf8')
    await appendSnapshotEntry(path, 3, { ...initialState, cursor: 3, status: 'error', error: 'sidecar is newer' })

    await expect(readSessionState(path)).rejects.toThrow(/refuses to fully read external Runtime session external/)
    const parsed = await readSessionState(path, { allowExternalRuntime: true })

    expect(parsed.snapshots).toHaveLength(1)
    expect(parsed.snapshots[0]?.seq).toBe(3)
    expect(parsed.snapshots[0]?.state.status).toBe('error')
  })

  it('includes a sidecar in full reads without duplicating an embedded snapshot at the same seq', async () => {
    const path = join(dir, 'full-read-sidecar.jsonl')
    await writeHeader({ path, sessionId: 'external', agentRuntime: 'copilot', config, initialState })
    await appendFile(path, `${JSON.stringify({ kind: 'snapshot', seq: 1, ts: new Date().toISOString(), state: { ...initialState, cursor: 1 } })}\n`, 'utf8')
    await appendFile(path, `${JSON.stringify({ kind: 'snapshot', seq: 2, ts: new Date().toISOString(), state: { ...initialState, cursor: 2, status: 'thinking' } })}\n`, 'utf8')
    await appendSnapshotEntry(path, 2, { ...initialState, cursor: 2, status: 'done' })

    const parsed = await readSessionLog(path, { allowExternalRuntime: true })

    expect(parsed.snapshots.map((snapshot) => snapshot.seq)).toEqual([1, 2])
    expect(parsed.snapshots.at(-1)?.state.status).toBe('done')
  })

  it('finds the latest snapshot from the tail without parsing earlier snapshots', async () => {
    const path = join(dir, 'last-snapshot.jsonl')
    await writeHeader({ path, sessionId: 'external', agentRuntime: 'copilot', config, initialState })
    await appendFile(path, `${JSON.stringify({ kind: 'snapshot', seq: 1, ts: new Date().toISOString(), state: { ...initialState, cursor: 1, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200_000) }] }] } })}\n`, 'utf8')
    await appendRuntimeMetadataEntry(path, { sessionId: 'external', action: 'between', payload: {} })
    await appendSnapshotEntry(path, 1, { ...initialState, cursor: 1, status: 'error', error: 'older sidecar' })
    await appendFile(path, `${JSON.stringify({ kind: 'snapshot', seq: 2, ts: new Date().toISOString(), state: { ...initialState, cursor: 2, status: 'done' } })}\n`, 'utf8')
    await appendRuntimeMetadataEntry(path, { sessionId: 'external', action: 'after', payload: {} })

    const snapshot = await readLastSessionSnapshot(path)

    expect(snapshot?.seq).toBe(2)
    expect(snapshot?.state.status).toBe('done')
  })

  it('returns a committed sidecar when only Tool receipt metadata was appended afterwards', async () => {
    const path = join(dir, 'receipt-after-sidecar.jsonl')
    await writeHeader({ path, sessionId: 'receipt-after-sidecar', agentRuntime: 'copilot', config, initialState })
    await appendSnapshotEntry(path, 1, { ...initialState, cursor: 1, status: 'done' })
    await appendRuntimeMetadataEntry(path, {
      sessionId: 'receipt-after-sidecar', action: 'copilot.tool_result_committed',
      payload: { callId: 'deploy-call', projectionCursor: 1 },
    })
    await expect(readLastSessionSnapshot(path)).resolves.toMatchObject({ seq: 1, state: { status: 'done' } })
  })

  it('round-trips header + events + snapshots cleanly', async () => {
    const path = join(dir, 'clean.jsonl')
    await writeHeader({ path, sessionId: 's1', config, initialState })
    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'hi' },
      effects: [],
    })
    const parsed = await readSessionLog(path)
    expect(parsed.header.sessionId).toBe('s1')
    expect(parsed.events).toHaveLength(1)
    expect(parsed.warnings).toEqual([])
  })

  it('round-trips bounded Turn timing metadata in the durable event entry', async () => {
    const path = join(dir, 'timing.jsonl')
    await writeHeader({ path, sessionId: 's-timing', config, initialState })
    const summary = { turnId: 'turn-1', status: 'completed' as const, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', wallDurationMs: 1000, estimated: false, queueDurationMs: 0, activeDurationMs: 1000, approvalWaitMs: 0, llm: { wallDurationMs: 1000, requestCount: 1 }, tools: { wallDurationMs: 0, aggregateDurationMs: 0, callCount: 0, peakConcurrency: 0, partial: false }, compactionDurationMs: 0, retryDurationMs: 0, recoveryDurationMs: 0 }
    await appendEventEntry({ path, seq: 1, event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, effects: [], timing: { turnId: 'turn-1', summary } })
    expect((await readSessionLog(path)).events[0]?.timing?.summary).toEqual(summary)
  })

  it('round-trips runtime metadata entries separately from kernel events', async () => {
    const path = join(dir, 'runtime-metadata.jsonl')
    await writeHeader({ path, sessionId: 's-runtime-meta', config, initialState })
    await appendRuntimeMetadataEntry(path, {
      sessionId: 's-runtime-meta',
      action: 'compaction_skipped',
      payload: { reason: 'no_compactable_content' },
      artifactRef: { path: 'artifacts/compact/report.json', bytes: 12, sha256: 'abc123' },
    })

    const parsed = await readSessionLog(path)
    expect(parsed.events).toEqual([])
    expect(parsed.runtimeMetadata).toHaveLength(1)
    expect(parsed.runtimeMetadata[0]).toMatchObject({
      kind: 'runtime_metadata',
      sessionId: 's-runtime-meta',
      action: 'compaction_skipped',
      payload: { reason: 'no_compactable_content' },
      artifactRef: { path: 'artifacts/compact/report.json', bytes: 12, sha256: 'abc123' },
    })
  })

  it('writes agent module prompt and registry artifacts beside the session log', async () => {
    const path = join(dir, 'module-session.jsonl')
    await writeHeader({
      path,
      sessionId: 's-module',
      config: {
        tools: [{
          name: 'demo',
          description: 'demo',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          toolsetId: 'demo-toolset',
          toolsetVersion: '1.0.0',
          risk: 'read',
          executionKind: 'executor',
          executionHandler: 'demo',
        }],
        systemPrompt: 'module prompt',
        agentModule: {
          id: 'demo-module',
          version: '1.0.0',
          label: 'Demo Module',
          systemPromptHash: 'prompt-hash',
          toolRegistryHash: 'tool-hash',
          toolsets: [{ id: 'demo-toolset', version: '1.0.0', label: 'Demo Toolset', toolCount: 1 }],
        },
      },
      initialState,
    })

    const artifactDir = join(dir, 'artifacts', 'module-session', 'agent-module')
    await expect(readFile(join(artifactDir, 'system-prompt.txt'), 'utf8')).resolves.toBe('module prompt')
    const registry = JSON.parse(await readFile(join(artifactDir, 'tool-registry.json'), 'utf8'))
    expect(registry.module.id).toBe('demo-module')
    expect(registry.tools[0].toolsetId).toBe('demo-toolset')
  })

  it('redacts LLM trace endpoint and credentials before writing event logs', async () => {
    const path = join(dir, 'llm-trace-redaction.jsonl')
    await writeHeader({ path, sessionId: 's-redaction', config, initialState })
    await appendEventEntry({
      path,
      seq: 1,
      event: {
        kind: 'llm_response',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
      effects: [],
      llmTrace: {
        provider: 'openai',
        model: 'gpt-test',
        request: {
          url: 'https://gateway.example.com/v1/chat/completions?api_key=query-secret',
          headers: {
            authorization: 'Bearer test-redacted-api-key',
            'x-api-key': 'anthropic-secret',
            'content-type': 'application/json',
          },
          body: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hello' }],
            baseUrl: 'https://gateway.example.com/v1',
            metadata: { token: 'body-secret' },
          },
        },
        response: {
          status: 401,
          body: {
            error: 'OPENAI_API_KEY=test-redacted-api-key rejected',
            url: 'https://gateway.example.com/v1/chat/completions',
          },
        },
      },
    })

    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('gateway.example.com')
    expect(raw).not.toContain('test-redacted-api-key')
    expect(raw).not.toContain('anthropic-secret')
    expect(raw).not.toContain('body-secret')

    const parsed = await readSessionLog(path)
    const entry = parsed.events[0]!
    expect(entry.llmTrace?.request.url).toBe('https://<redacted>/v1/chat/completions')
    expect(entry.llmTrace?.request.body).toBeUndefined()
    expect(entry.llmTraceArtifact?.path).toContain('llm-traces')
    const trace = JSON.parse(await readFile(join(dir, entry.llmTraceArtifact!.path), 'utf8'))
    expect(trace.request.url).toBe('https://<redacted>/v1/chat/completions')
    expect(trace.request.headers.authorization).toBe('[redacted]')
    expect(trace.request.headers['x-api-key']).toBe('[redacted]')
    expect(trace.request.headers['content-type']).toBe('application/json')
  })

  it('does not duplicate call_llm history when a full redacted trace is retained', async () => {
    const path = join(dir, 'single-llm-authority.jsonl')
    await writeHeader({ path, sessionId: 's-single-llm-authority', config, initialState })
    const entry = await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'hello' },
      effects: [{
        kind: 'call_llm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'large request history' }] }],
        tools: [],
      }],
      llmTrace: {
        provider: 'openai',
        model: 'gpt-test',
        request: {
          url: 'https://gateway.example.com/v1/chat/completions',
          headers: {},
          body: { messages: [{ role: 'user', content: 'large request history' }] },
        },
      },
    })

    expect(entry.llmTraceArtifact).toBeDefined()
    expect(entry.effectsArtifact).toBeUndefined()
    expect(entry.effects).toEqual([{ kind: 'call_llm', messages: [], tools: [] }])
  })

  it('recovers from a truncated final line (crash mid-append)', async () => {
    // Simulate the exact failure: valid header + valid event, then a partial
    // JSON blob with no trailing newline. This is what a SIGKILL between the
    // `write(fd, buf)` syscall and the newline byte would leave on disk.
    const path = join(dir, 'truncated.jsonl')
    await writeHeader({ path, sessionId: 's-crash', config, initialState })
    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'first' },
      effects: [],
    })
    // Append a partial line: opening brace only, no newline. Before the fix
    // this made the whole log unreadable — every prior event became dark.
    await appendFile(path, '{"kind":"event","seq":2,"ts":"2026', 'utf8')

    const parsed = await readSessionLog(path)
    expect(parsed.header.sessionId).toBe('s-crash')
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0]!.seq).toBe(1)
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toMatch(/truncated final line/i)
  })

  it('still throws on corruption in the middle of the file', async () => {
    // The tolerance is deliberately narrow: only the *last* line, only when
    // it lacks a trailing newline. Corruption anywhere else is a real bug
    // and must never be silently swallowed.
    const path = join(dir, 'bad-middle.jsonl')
    await writeHeader({ path, sessionId: 's-mid', config, initialState })
    // Insert garbage as a complete (newline-terminated) middle line.
    await appendFile(path, 'not-json-at-all\n', 'utf8')
    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'after-corruption' },
      effects: [],
    })
    await expect(readSessionLog(path)).rejects.toThrow(/Malformed JSON at line 2/)
  })

  it('does not swallow a final line that IS newline-terminated but malformed', async () => {
    // If the final line ends with \n, it was fully flushed and any parse
    // failure is real corruption, not truncation.
    const path = join(dir, 'bad-last.jsonl')
    await writeHeader({ path, sessionId: 's-last', config, initialState })
    await appendFile(path, 'not-json\n', 'utf8')
    await expect(readSessionLog(path)).rejects.toThrow(/Malformed JSON at line 2/)
  })

  it('throws on an empty file (no header)', async () => {
    const path = join(dir, 'empty.jsonl')
    await writeFile(path, '', 'utf8')
    await expect(readSessionLog(path)).rejects.toThrow(/Empty log/)
  })

  it('throws when first entry is not a header', async () => {
    const path = join(dir, 'no-header.jsonl')
    await writeFile(
      path,
      JSON.stringify({ kind: 'event', seq: 0 }) + '\n',
      'utf8',
    )
    await expect(readSessionLog(path)).rejects.toThrow(/missing header/)
  })

  it('handles a file consisting solely of a truncated header', async () => {
    // Rare but real: crash before the very first newline is written. There's
    // nothing to recover — the log has no complete entries — so we surface
    // an empty-log error, not a truncation warning.
    const path = join(dir, 'header-truncated.jsonl')
    await writeFile(path, '{"kind":"header","sessionI', 'utf8')
    await expect(readSessionLog(path)).rejects.toThrow(/Empty log/)
    // Sanity: the raw file really did have contents.
    expect((await readFile(path, 'utf8')).length).toBeGreaterThan(0)
  })

  it('preserves and resequences durable events when a legacy log contains duplicate sequences', async () => {
    const path = join(dir, 'duplicate-seq.jsonl')
    await writeHeader({ path, sessionId: 'dup', config, initialState })
    await appendEventEntry({ path, seq: 1, event: { kind: 'user_message', text: 'first' }, effects: [] })
    await appendEventEntry({ path, seq: 1, event: { kind: 'user_message', text: 'racing duplicate' }, effects: [] })

    const parsed = await readSessionLog(path)
    expect(parsed.events.map((entry) => ({ seq: entry.seq, event: entry.event }))).toMatchObject([
      { seq: 1, event: { kind: 'user_message', text: 'first' } },
      { seq: 2, event: { kind: 'user_message', text: 'racing duplicate' } },
    ])
    expect(parsed.warnings).toContain('Repaired event sequence 1 to 2 after 1')
  })

  it('preserves physical append order while repairing regressing and gapped legacy sequences', async () => {
    const path = join(dir, 'regressing-seq.jsonl')
    await writeHeader({ path, sessionId: 'regress', config, initialState })
    await appendEventEntry({ path, seq: 1, event: { kind: 'user_message', text: 'one' }, effects: [] })
    await appendEventEntry({ path, seq: 3, event: { kind: 'cancel' }, effects: [] })
    await appendEventEntry({ path, seq: 2, event: { kind: 'cancel' }, effects: [] })

    const parsed = await readSessionLog(path)
    expect(parsed.events.map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(parsed.events.map((entry) => entry.event.kind)).toEqual(['user_message', 'cancel', 'cancel'])
    expect(parsed.warnings).toContain('Repaired event sequence 3 to 2 after 1')
    expect(parsed.warnings).toContain('Repaired event sequence 2 to 3 after 3')
  })

  it('finds committed operations without parsing historical snapshots', async () => {
    const path = join(dir, 'operation-lookup.jsonl')
    await writeHeader({ path, sessionId: 'operation-lookup', config, initialState })
    await appendFile(path, '{"kind":"snapshot","ignored":"historical invalid snapshot"\n', 'utf8')
    await appendRuntimeMetadataEntry(path, {
      sessionId: 'operation-lookup',
      action: 'copilot.user_message',
      payload: { operationId: 'runtime-operation' },
    })
    await appendEventEntry({
      path,
      seq: 7,
      event: { kind: 'user_message', operationId: 'event-operation', text: 'hello' },
      effects: [],
    })

    await expect(findSessionOperation(path, 'runtime-operation')).resolves.toEqual({ kind: 'runtime_metadata' })
    await expect(findSessionOperation(path, 'event-operation')).resolves.toEqual({
      kind: 'event',
      cursor: 7,
      event: { kind: 'user_message', operationId: 'event-operation', text: 'hello' },
    })
    await expect(findSessionOperation(path, 'missing-operation')).resolves.toBeUndefined()
  })

  it('finds the latest matching runtime metadata without parsing older malformed entries', async () => {
    const path = join(dir, 'latest-runtime-metadata.jsonl')
    await writeHeader({ path, sessionId: 'latest-runtime-metadata', config, initialState })
    await appendFile(path, '{"kind":"runtime_metadata","action":"message_queue_snapshot",malformed\n', 'utf8')
    await appendRuntimeMetadataEntry(path, {
      sessionId: 'latest-runtime-metadata',
      action: 'message_queue_snapshot',
      payload: { schemaVersion: 1, items: [{ id: 'latest' }] },
    })

    await expect(findLatestRuntimeMetadata(path, 'message_queue_snapshot')).resolves.toMatchObject({
      action: 'message_queue_snapshot',
      payload: { items: [{ id: 'latest' }] },
    })
  })

  it('uses snapshot time to filter orphaned legacy projection metadata without a cursor', async () => {
    const path = join(dir, 'legacy-runtime-metadata.jsonl')
    await writeHeader({ path, sessionId: 'legacy-runtime-metadata', config, initialState })
    const entry = (ts: string, text: string) => JSON.stringify({
      kind: 'runtime_metadata', ts, sessionId: 'legacy-runtime-metadata',
      action: 'copilot.user_message', payload: { text },
    })
    await appendFile(path, `${entry('2026-01-01T00:00:00.000Z', 'committed')}\n${entry('2999-01-01T00:00:00.000Z', 'orphan')}\n`, 'utf8')

    await expect(findLatestRuntimeMetadata(path, 'copilot.user_message', {
      committedProjection: { cursor: 1, ts: '2026-01-02T00:00:00.000Z' },
    })).resolves.toMatchObject({ payload: { text: 'committed' } })
  })

  it('checks Kernel results by call identity without accepting a Copilot metadata entry', async () => {
    const path = join(dir, 'kernel-tool-result.jsonl')
    await writeHeader({ path, sessionId: 'kernel-result', config, initialState })
    await appendRuntimeMetadataEntry(path, { sessionId: 'kernel-result', action: 'copilot.tool_result_committed', payload: { callId: 'other', projectionCursor: 1 } })
    await appendEventEntry({ path, seq: 1, event: { kind: 'tool_result', callId: 'expected', ok: false, content: 'failed' }, effects: [] })
    await expect(findPersistedToolResult(path, 'expected', 'kernel')).resolves.toBe(true)
    await expect(findPersistedToolResult(path, 'other', 'kernel')).resolves.toBe(false)
  })

  it('requires a committed Copilot snapshot, not just a pre-projection result', async () => {
    const path = join(dir, 'copilot-result.jsonl')
    await writeHeader({ path, sessionId: 'copilot-result', agentRuntime: 'copilot', config, initialState })
    await appendRuntimeMetadataEntry(path, { sessionId: 'copilot-result', action: 'copilot.tool_result', payload: { callId: 'pending', ok: true, projectionCursor: 1 } })
    await expect(findPersistedToolResult(path, 'pending', 'copilot')).resolves.toBe(false)
    await appendSnapshotEntry(path, 1, { ...initialState, cursor: 1, messages: [] })
    await expect(findPersistedToolResult(path, 'pending', 'copilot')).resolves.toBe(false)

    const withResult = { ...initialState, cursor: 2, messages: [{ role: 'tool' as const, content: [{ type: 'tool_result' as const, callId: 'legacy', ok: true, content: 'ok' }] }] }
    await appendRuntimeMetadataEntry(path, { sessionId: 'copilot-result', action: 'copilot.tool_result', payload: { callId: 'legacy', ok: true, projectionCursor: 2 } })
    await appendSnapshotEntry(path, 2, withResult)
    await expect(findPersistedToolResult(path, 'legacy', 'copilot')).resolves.toBe(true)
    await expect(findPersistedToolResult(path, 'pending', 'copilot')).resolves.toBe(false)

    await appendRuntimeMetadataEntry(path, { sessionId: 'copilot-result', action: 'copilot.tool_result_committed', payload: { callId: 'new', projectionCursor: 2 } })
    await expect(findPersistedToolResult(path, 'new', 'copilot')).resolves.toBe(true)
    await expect(findPersistedToolResult(path, 'missing', 'copilot')).resolves.toBe(false)
    await expect(findPersistedToolResult(path, 'legacy', 'kernel')).resolves.toBe(false)
  })

  it('rejects historical results after a newer invocation reuses the call ID', async () => {
    const copilot = join(dir, 'reused-copilot.jsonl')
    await writeHeader({ path: copilot, sessionId: 'reused-copilot', agentRuntime: 'copilot', config, initialState })
    await appendRuntimeMetadataEntry(copilot, { sessionId: 'reused-copilot', action: 'copilot.tool_result', payload: { callId: 'again', projectionCursor: 1 } })
    await appendSnapshotEntry(copilot, 1, { ...initialState, cursor: 1, messages: [{ role: 'tool', content: [{ type: 'tool_result', callId: 'again', ok: true, content: 'old' }] }] })
    await appendRuntimeMetadataEntry(copilot, { sessionId: 'reused-copilot', action: 'copilot.tool_call', payload: { callId: 'again', projectionCursor: 2 } })
    expect(await findPersistedToolResult(copilot, 'again', 'copilot')).toBe(false)

    const kernel = join(dir, 'reused-kernel.jsonl')
    await writeHeader({ path: kernel, sessionId: 'reused-kernel', config, initialState })
    await appendEventEntry({ path: kernel, seq: 1, event: { kind: 'tool_result', callId: 'again', ok: true, content: 'old' }, effects: [] })
    await appendEventEntry({ path: kernel, seq: 2, event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'again', name: 'shell', input: {} }] } }, effects: [] })
    expect(await findPersistedToolResult(kernel, 'again', 'kernel')).toBe(false)
  })

  it('ignores a giant embedded snapshot containing the call ID without materializing it', async () => {
    const path = join(dir, 'giant-snapshot.jsonl')
    await writeHeader({ path, sessionId: 'giant-snapshot', config, initialState })
    await appendFile(path, `${JSON.stringify({ kind: 'snapshot', callId: 'probe', padding: 'x'.repeat(3 * 1024 * 1024) })}\n`, 'utf8')
    expect(await findPersistedToolResult(path, 'probe', 'kernel')).toBe(false)
  })

  it('does not accept an old result outside the bounded recent log tail', async () => {
    const path = join(dir, 'old-result.jsonl')
    await writeHeader({ path, sessionId: 'old-result', config, initialState })
    await appendEventEntry({ path, seq: 1, event: { kind: 'tool_result', callId: 'old', ok: true, content: 'old' }, effects: [] })
    await truncate(path, 140 * 1024 * 1024)
    await appendFile(path, '\n', 'utf8')
    await expect(findPersistedToolResult(path, 'old', 'kernel')).resolves.toBe(false)
  })

  it('keeps queue and operation lookups bounded on a 1.4 GiB Session log', async () => {
    const path = join(dir, 'large-session.jsonl')
    await writeHeader({ path, sessionId: 'large-session', config, initialState })
    await truncate(path, 1_400 * 1024 * 1024)
    await appendFile(path, '\n', 'utf8')
    await appendRuntimeMetadataEntry(path, {
      sessionId: 'large-session',
      action: 'message_queue_snapshot',
      payload: { schemaVersion: 1, items: [] },
    })

    const startedAt = performance.now()
    await expect(findLatestRuntimeMetadata(path, 'message_queue_snapshot')).resolves.toMatchObject({
      action: 'message_queue_snapshot',
    })
    await expect(findSessionOperation(
      path,
      '00000000-0000-4000-8000-000000000000',
      { maxScanBytes: 64 * 1024 * 1024 },
    )).resolves.toBeUndefined()
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  })
})
