/**
 * Persistence layer: JSONL log round-trip and crash-recovery cases.
 *
 * We care especially about the "process died mid-write" scenario since it's
 * the only way a real deployment produces a malformed log file: `appendFile`
 * is atomic per-call in Node.js, but a SIGKILL between the write() syscall
 * and the newline byte still leaves a partial line on disk.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentConfig, AgentState } from '@agent-kernel/kernel'

import {
  appendEventEntry,
  appendRuntimeMetadataEntry,
  readSessionLog,
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
})
