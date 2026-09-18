/**
 * SessionStore tests. Focused on the concurrent-create race where two
 * dashboard+executor sockets could otherwise land two different log files on
 * disk for the same sessionId; `ensure()` coalesces via a per-id promise map.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfig, step } from '@agent-kernel/kernel'

import { SessionStore } from './session.js'
import { appendEventEntry, appendSnapshotEntry, readSessionLog, writeHeader } from './log.js'
import { createInitialState } from '@agent-kernel/kernel'

const config = createConfig({ tools: [], systemPrompt: 'sys' })

describe('SessionStore.ensure', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-store-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('locks observable tool versions and schema hashes at session creation', async () => {
    const store = new SessionStore(dir)
    const versioned = createConfig({ tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' }, requiresApproval: false, version: '2.1.0', schemaHash: 'sha256:test' }] })
    const record = await store.create({ sessionId: 'tool-lock', config: versioned })
    expect(record.toolLock).toEqual({ read: { version: '2.1.0', schemaHash: 'sha256:test' } })
  })

  it('reloads Copilot sessions from snapshots and settles interrupted turns without kernel events', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-session',
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: 'copilot-session',
      config,
    })
    expect((await store.listSummaries())[0]).toMatchObject({
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
    })
    const projected = {
      ...record.state,
      cursor: 1,
      status: 'thinking' as const,
      pendingCalls: [] as const,
      messages: [...record.state.messages, {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hello copilot' }],
      }],
    }
    await store.recordRuntimeProjection(record.sessionId, projected, 'copilot.user_message', { text: 'hello copilot' })

    const reloaded = await new SessionStore(dir).load(record.sessionId)
    expect(reloaded.agentRuntime).toBe('copilot')
    expect(reloaded.externalSessionId).toBe('copilot-session')
    expect(reloaded.state.status).toBe('error')
    expect(reloaded.state.cursor).toBe(2)
    expect(reloaded.state.messages).toEqual(projected.messages)
    expect(reloaded.state.pendingCalls).toEqual([])
    expect(reloaded.state.error).toBe('Copilot turn was interrupted by a host restart')
    const log = await readSessionLog(record.logPath, { allowExternalRuntime: true })
    expect(log.events).toHaveLength(0)
    expect(log.snapshots).toHaveLength(2)
    expect(log.runtimeMetadata.at(-1)?.action).toBe('copilot.recovered_interrupted_turn')
  })

  it('compacts large Copilot projection snapshots without mutating live state', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-large-projection',
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: 'copilot-large-projection',
      config,
    })
    const largeToolOutput = `${'x'.repeat(512 * 1024)}\n\n--- output truncated: 10 / 1000 lines, 32768 / 524288 bytes stored at overflow://call-large\n--- use \`read { path: '/tmp/call-large.txt' }\` to read more`
    const projected = {
      ...record.state,
      cursor: 1,
      status: 'done' as const,
      pendingCalls: [] as const,
      messages: [
        ...record.state.messages,
        {
          role: 'assistant' as const,
          content: [{ type: 'tool_call' as const, callId: 'call-large', name: 'shell', input: { command: 'node build.js' } }],
        },
        {
          role: 'tool' as const,
          content: [{ type: 'tool_result' as const, callId: 'call-large', ok: true, content: largeToolOutput }],
        },
      ],
    }

    await store.recordRuntimeProjection(record.sessionId, projected, 'copilot.tool_result', { callId: 'call-large' })

    expect(record.state.messages.at(-1)?.content[0]).toMatchObject({ type: 'tool_result', content: largeToolOutput })
    const log = await readSessionLog(record.logPath, { allowExternalRuntime: true })
    const snapshotJson = JSON.stringify(log.snapshots.at(-1))
    const toolResult = log.snapshots.at(-1)?.state.messages.at(-1)?.content[0]
    expect(Buffer.byteLength(snapshotJson)).toBeLessThan(2 * 1024 * 1024)
    expect(toolResult).toMatchObject({ type: 'tool_result', callId: 'call-large', ok: true })
    expect(toolResult?.type === 'tool_result' ? toolResult.content : '').toContain('overflow://call-large')
    expect(toolResult?.type === 'tool_result' ? toolResult.content.length : 0).toBeLessThan(64 * 1024)
  })

  it('replaces old Copilot projection messages when a snapshot would exceed the hard cap', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-long-projection',
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: 'copilot-long-projection',
      config,
    })
    const projected = {
      ...record.state,
      cursor: 1,
      status: 'done' as const,
      pendingCalls: [] as const,
      messages: [
        ...record.state.messages,
        ...Array.from({ length: 700 }, (_, index) => ({
          role: 'tool' as const,
          content: [{
            type: 'tool_result' as const,
            callId: `call-${index}`,
            ok: true,
            content: `tool ${index}\n${'x'.repeat(40 * 1024)}`,
          }],
        })),
      ],
    }

    await store.recordRuntimeProjection(record.sessionId, projected, 'copilot.bulk_projection', { count: 700 })

    const log = await readSessionLog(record.logPath, { allowExternalRuntime: true })
    const snapshot = log.snapshots.at(-1)
    const snapshotJson = JSON.stringify(snapshot)
    const compactedMessages = snapshot?.state.messages.filter((message) =>
      message.content.some((content) => content.type === 'tool_result' && content.content.includes('older tool result compacted')),
    ) ?? []
    expect(Buffer.byteLength(snapshotJson)).toBeLessThan(2 * 1024 * 1024)
    expect(compactedMessages.length).toBeGreaterThan(0)
    expect(snapshot?.state.messages.at(-1)?.content[0]).toMatchObject({ type: 'tool_result', callId: 'call-699' })
  })

  it.runIf(process.platform === 'linux')('loads a large Copilot projection log without summary cache or full replay', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-large-no-summary',
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: 'copilot-large-no-summary',
      config,
    })
    truncateSync(record.logPath, 1_400 * 1024 * 1024)
    appendFileSync(record.logPath, '\n', 'utf8')
    await appendSnapshotEntry(record.logPath, 1234, {
      ...record.state,
      cursor: 1234,
      status: 'done',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'loaded from latest projection snapshot' }],
      }],
    })

    const startedAt = performance.now()
    const reloaded = await new SessionStore(dir).load(record.sessionId, { recoverDangling: false })

    expect(performance.now() - startedAt).toBeLessThan(1000)
    expect(reloaded.state.cursor).toBe(1234)
    expect(reloaded.state.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'loaded from latest projection snapshot' }])
    await expect(readSessionLog(record.logPath)).rejects.toThrow(/refuses to fully read external Runtime session copilot-large-no-summary/)
  })

  it('recovers a cached Copilot approval after read-only candidate inspection', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-cached-approval',
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      config,
    })
    await store.recordRuntimeProjection(record.sessionId, {
      ...record.state,
      cursor: record.state.cursor + 1,
      status: 'awaiting_approval',
      pendingCalls: [{
        callId: 'call-restart',
        name: 'shell',
        input: { command: 'true' },
        status: 'awaiting_approval',
      }],
      messages: [...record.state.messages, {
        role: 'assistant',
        content: [{
          type: 'tool_call',
          callId: 'call-restart',
          name: 'shell',
          input: { command: 'true' },
        }],
      }],
    }, 'copilot.tool_call', { callId: 'call-restart' })

    const replacement = new SessionStore(dir)
    const inspected = await replacement.load(record.sessionId, { recoverDangling: false })
    expect(inspected.state.status).toBe('awaiting_approval')

    const [first, second] = await Promise.all([
      replacement.load(record.sessionId),
      replacement.load(record.sessionId),
    ])

    expect(first).toBe(second)
    expect(first.state.status).toBe('error')
    expect(first.state.pendingCalls).toEqual([])
    expect(first.state.messages.flatMap((message) => message.content)).toContainEqual({
      type: 'tool_result',
      callId: 'call-restart',
      ok: false,
      content: 'host restarted while call was pending',
    })
    const parsed = await readSessionLog(record.logPath, { allowExternalRuntime: true })
    expect(parsed.runtimeMetadata.filter((entry) => entry.action === 'copilot.recovered_interrupted_turn')).toHaveLength(1)
  })

  it('does not recover an external Runtime turn projected by the current Host process', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-live-current-process',
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      config,
    })
    await store.recordRuntimeProjection(record.sessionId, {
      ...record.state,
      cursor: record.state.cursor + 1,
      status: 'awaiting_approval',
      pendingCalls: [{
        callId: 'call-live',
        name: 'shell',
        input: { command: 'true' },
        status: 'awaiting_approval',
      }],
      messages: [...record.state.messages, {
        role: 'assistant',
        content: [{
          type: 'tool_call',
          callId: 'call-live',
          name: 'shell',
          input: { command: 'true' },
        }],
      }],
    }, 'copilot.tool_call', { callId: 'call-live' })

    const loaded = await store.load(record.sessionId)

    expect(loaded.state.status).toBe('awaiting_approval')
    expect(loaded.state.pendingCalls).toHaveLength(1)
    const parsed = await readSessionLog(record.logPath, { allowExternalRuntime: true })
    expect(parsed.runtimeMetadata.some((entry) => entry.action === 'copilot.recovered_interrupted_turn')).toBe(false)
  })

  it('quarantines Kernel events written into a Copilot Session', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-kernel-contamination',
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      config,
    })
    await appendEventEntry({
      path: record.logPath,
      seq: 1,
      event: { kind: 'user_message', text: 'wrong loop' },
      effects: [],
    })

    const replacement = new SessionStore(dir)
    const inspected = await replacement.load(record.sessionId, { recoverDangling: false })
    expect(inspected.state.status).toBe('idle')

    const recovered = await replacement.load(record.sessionId)

    expect(recovered.state.status).toBe('error')
    expect(recovered.state.cursor).toBe(1)
    expect(recovered.state.error).toBe('Non-Kernel Session contained Kernel events and was quarantined')
    const parsed = await readSessionLog(record.logPath, { allowExternalRuntime: true })
    expect(parsed.runtimeMetadata.at(-1)?.action).toBe('runtime.quarantined_kernel_events')
    expect(parsed.snapshots.at(-1)?.state.status).toBe('error')
  })

  it('preserves the highest foreign Kernel cursor when quarantining a Copilot Session', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-kernel-cursor',
      agentRuntime: 'copilot',
      config,
    })
    await appendEventEntry({
      path: record.logPath,
      seq: 1,
      event: { kind: 'user_message', text: 'wrong loop' },
      effects: [],
    })
    await appendEventEntry({
      path: record.logPath,
      seq: 2,
      event: { kind: 'llm_response', content: [{ type: 'text', text: 'wrong runtime' }] },
      effects: [],
    })

    const recovered = await new SessionStore(dir).load(record.sessionId)

    expect(recovered.state.cursor).toBe(2)
    expect(recovered.state.status).toBe('error')
  })

  it('returns the same record for concurrent callers and writes ONE log file', async () => {
    // The race: dashboard + executor sockets arrive in the same tick, both
    // find no cached record, both fail to load, both call create() with a
    // filename that embeds `new Date().toISOString()` — producing TWO
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
    // the same record — not throw "unknown session".
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

  it('deletes the exact Session log and every Session-partitioned artifact', async () => {
    const artifactRootDir = join(dir, 'host-artifacts')
    const deletedRegistered: string[] = []
    const store = new SessionStore(dir, {
      artifactRootDir,
      deleteRegisteredArtifacts: async (sessionId) => { deletedRegistered.push(sessionId) },
    })
    const record = await store.create({ sessionId: 'session-delete-exact', config })
    const logSlug = basename(record.logPath, '.jsonl')
    const logArtifacts = join(dir, 'artifacts', logSlug)
    const similarlyNamed = join(dir, 'artifacts', `${logSlug}-other`)
    mkdirSync(logArtifacts, { recursive: true })
    mkdirSync(similarlyNamed, { recursive: true })
    writeFileSync(join(logArtifacts, 'request.json'), '{}')
    for (const kind of ['message-assembly', 'router-decisions', 'tool-catalog', 'compaction-summaries', 'subagent-policies']) {
      const partition = join(artifactRootDir, kind, record.sessionId)
      mkdirSync(partition, { recursive: true })
      writeFileSync(join(partition, '1.json'), '{}')
    }

    await store.delete(record.sessionId)

    expect(existsSync(record.logPath)).toBe(false)
    expect(existsSync(logArtifacts)).toBe(false)
    expect(existsSync(similarlyNamed)).toBe(true)
    for (const kind of ['message-assembly', 'router-decisions', 'tool-catalog', 'compaction-summaries', 'subagent-policies']) {
      expect(existsSync(join(artifactRootDir, kind, record.sessionId))).toBe(false)
    }
    expect(deletedRegistered).toEqual([record.sessionId])
  })

  it('removes orphaned log artifacts after an earlier partial delete', async () => {
    const sessionId = 'session-partially-deleted'
    const orphan = join(dir, 'artifacts', `2026-08-20T00-00-00.000Z_${sessionId}`)
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'response.json'), '{}')

    await new SessionStore(dir).delete(sessionId)

    expect(existsSync(orphan)).toBe(false)
  })

  it('purges only sessions attributed to the requested organization', async () => {
    const artifactRootDir = join(dir, 'host-artifacts')
    const deletedRegistered: string[] = []
    const store = new SessionStore(dir, {
      artifactRootDir,
      deleteRegisteredArtifacts: async (sessionId) => { deletedRegistered.push(sessionId) },
    })
    const acme = await store.create({
      sessionId: 'tenant-purge-acme',
      config,
      organizationId: 'org_acme',
      principal: 'member@example.test',
      organizationRole: 'member',
    })
    const other = await store.create({
      sessionId: 'tenant-purge-other',
      config,
      organizationId: 'org_other',
      principal: 'other@example.test',
      organizationRole: 'member',
    })
    mkdirSync(join(artifactRootDir, 'message-assembly', acme.sessionId), { recursive: true })
    writeFileSync(join(artifactRootDir, 'message-assembly', acme.sessionId, '1.json'), '{}')
    mkdirSync(join(artifactRootDir, 'message-assembly', other.sessionId), { recursive: true })
    writeFileSync(join(artifactRootDir, 'message-assembly', other.sessionId, '1.json'), '{}')

    await expect(store.purgeOrganizationSessions({ organizationId: 'org_acme' })).resolves.toEqual({
      sessions: 1,
      sessionIds: ['tenant-purge-acme'],
    })

    expect(existsSync(acme.logPath)).toBe(false)
    expect(existsSync(join(artifactRootDir, 'message-assembly', acme.sessionId))).toBe(false)
    expect(existsSync(other.logPath)).toBe(true)
    expect(existsSync(join(artifactRootDir, 'message-assembly', other.sessionId, '1.json'))).toBe(true)
    expect(deletedRegistered).toEqual(['tenant-purge-acme'])
  })

  it('retention-purges only tenant sessions older than the cutoff', async () => {
    const store = new SessionStore(dir)
    const old = await store.create({ sessionId: 'tenant-purge-old', config, organizationId: 'org_acme' })
    const fresh = await store.create({ sessionId: 'tenant-purge-fresh', config, organizationId: 'org_acme' })
    ;(old as { lastEventAt?: string }).lastEventAt = '2026-01-01T00:00:00.000Z'
    ;(fresh as { lastEventAt?: string }).lastEventAt = '2026-09-07T00:00:00.000Z'

    const result = await store.purgeOrganizationSessions({
      organizationId: 'org_acme',
      before: new Date('2026-06-01T00:00:00.000Z'),
    })

    expect(result).toEqual({ sessions: 1, sessionIds: ['tenant-purge-old'] })
    expect(existsSync(old.logPath)).toBe(false)
    expect(existsSync(fresh.logPath)).toBe(true)
  })

  it('backfills missing workspace and initial cwd on an existing cached session', async () => {
    const store = new SessionStore(dir)
    const first = await store.ensure({
      sessionId: 'sess-backfill-cached',
      defaultConfig: config,
    })

    const backfilled = await store.ensure({
      sessionId: 'sess-backfill-cached',
      defaultConfig: config,
      workspaceId: 'ws-backfill',
      workspaceName: 'backfill-box',
      initialCwd: '/tmp/backfill',
    })

    expect(backfilled.record).toBe(first.record)
    expect(backfilled.created).toBe(false)
    expect(backfilled.record.workspaceId).toBe('ws-backfill')
    expect(backfilled.record.workspaceName).toBe('backfill-box')
    expect(backfilled.record.state.cwd).toBe('/tmp/backfill')

    const reloaded = await new SessionStore(dir).load('sess-backfill-cached')
    expect(reloaded.workspaceId).toBe('ws-backfill')
    expect(reloaded.workspaceName).toBe('backfill-box')
    expect(reloaded.state.cwd).toBe('/tmp/backfill')
  })

  it('does not overwrite existing workspace or cwd during ensure backfill', async () => {
    const store = new SessionStore(dir)
    const first = await store.ensure({
      sessionId: 'sess-no-overwrite',
      defaultConfig: config,
      workspaceId: 'ws-original',
      workspaceName: 'original-box',
      initialCwd: '/tmp/original',
    })

    await store.ensure({
      sessionId: 'sess-no-overwrite',
      defaultConfig: config,
      workspaceId: 'ws-new',
      workspaceName: 'new-box',
      initialCwd: '/tmp/new',
    })

    expect(first.record.workspaceId).toBe('ws-original')
    expect(first.record.workspaceName).toBe('original-box')
    expect(first.record.state.cwd).toBe('/tmp/original')
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

  it('uses the current runtime tool catalog when loading an old session log', async () => {
    const sessionId = 'sess-runtime-tools'
    const oldRead = { name: 'read', description: 'old read', inputSchema: { type: 'object' }, requiresApproval: false }
    const newReadFile = { name: 'read_file', description: 'new read', inputSchema: { type: 'object' }, requiresApproval: false }
    const oldConfig = createConfig({ tools: [oldRead], systemPrompt: 'sys' })
    const newConfig = createConfig({ tools: [newReadFile], systemPrompt: 'sys' })

    const writer = new SessionStore(dir)
    const created = await writer.create({ sessionId, config: oldConfig })
    const persisted = await readSessionLog(created.logPath)
    expect(persisted.header.config.tools.map((tool) => tool.name)).toEqual(['read'])

    const reader = new SessionStore(dir, { runtimeConfig: newConfig })
    const loaded = await reader.load(sessionId)
    expect(loaded.config.tools.map((tool) => tool.name)).toEqual(['read_file'])

    const { effects } = step(loaded.state, { kind: 'user_message', text: 'what tools are available?' }, loaded.config)
    expect(effects).toHaveLength(1)
    expect(effects[0]).toMatchObject({ kind: 'call_llm' })
    if (effects[0]?.kind === 'call_llm') {
      expect(effects[0].tools.map((tool) => tool.name)).toEqual(['read_file'])
    }
  })
})

describe('SessionStore.rename', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-rename-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists a label as a metadata entry and reflects it in summaries', async () => {
    const store = new SessionStore(dir)
    const { record } = await store.ensure({
      sessionId: 'sess-rename',
      defaultConfig: config,
    })
    await store.rename(record.sessionId, '  My debugging session  ')

    // In-memory record is trimmed and updated in place.
    expect(record.label).toBe('My debugging session')

    // Persisted metadata line contains the trimmed label.
    const parsed = await readSessionLog(record.logPath)
    expect(parsed.metadata).toHaveLength(1)
    expect(parsed.metadata[0]!.label).toBe('My debugging session')

    // listSummaries picks up the label from metadata.
    const [summary] = await store.listSummaries()
    expect(summary?.label).toBe('My debugging session')
  })

  it('clears the override when the trimmed label is empty', async () => {
    const store = new SessionStore(dir)
    const { record } = await store.ensure({
      sessionId: 'sess-clear',
      defaultConfig: config,
    })
    await store.rename(record.sessionId, 'temporary')
    await store.rename(record.sessionId, '   ')

    expect(record.label).toBeUndefined()
    const [summary] = await store.listSummaries()
    expect(summary?.label).toBeUndefined()
  })

  it('rehydrates the label from disk after a fresh SessionStore', async () => {
    const store1 = new SessionStore(dir)
    const { record } = await store1.ensure({
      sessionId: 'sess-persist-label',
      defaultConfig: config,
    })
    await store1.rename(record.sessionId, 'Persisted title')

    const store2 = new SessionStore(dir)
    const rec2 = await store2.load('sess-persist-label')
    expect(rec2.label).toBe('Persisted title')
  })
})

describe('SessionStore.updatePreferences', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-prefs-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists selectedModel metadata and restores it after reload', async () => {
    const store = new SessionStore(dir)
    const { record } = await store.ensure({ sessionId: 'sess-model-pref', defaultConfig: config })

    const applied = await store.updatePreferences(record.sessionId, { selectedModel: 'anthropic:claude-opus' })

    expect(applied.selectedModel).toBe('anthropic:claude-opus')
    expect(record.preferences.selectedModel).toBe('anthropic:claude-opus')
    let parsed = await readSessionLog(record.logPath)
    expect(parsed.metadata.at(-1)?.selectedModel).toBe('anthropic:claude-opus')

    const reloaded = await new SessionStore(dir).load(record.sessionId)
    expect(reloaded.preferences.selectedModel).toBe('anthropic:claude-opus')

    await store.updatePreferences(record.sessionId, { selectedModel: '   ' })
    expect(record.preferences.selectedModel).toBeUndefined()
    parsed = await readSessionLog(record.logPath)
    expect(parsed.metadata.at(-1)?.selectedModel).toBe('')
    const cleared = await new SessionStore(dir).load(record.sessionId)
    expect(cleared.preferences.selectedModel).toBeUndefined()
  })

  it('persists Tool Card Mode and exposes it in session summaries', async () => {
    const store = new SessionStore(dir)
    const { record } = await store.ensure({ sessionId: 'sess-tool-card-mode', defaultConfig: config })

    await store.updatePreferences(record.sessionId, { toolCardMode: 'standard' })

    const parsed = await readSessionLog(record.logPath)
    expect(parsed.metadata.at(-1)?.toolCardMode).toBe('standard')
    expect((await store.listSummaries()).find((summary) => summary.sessionId === record.sessionId)?.preferences?.toolCardMode).toBe('standard')
    const reloaded = await new SessionStore(dir).load(record.sessionId)
    expect(reloaded.preferences.toolCardMode).toBe('standard')
  })
})

describe('SessionStore runtime context snapshots', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-runtime-context-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('restores provider-reported context usage after a Host restart', async () => {
    const store = new SessionStore(dir)
    const record = await store.create({
      sessionId: 'copilot-context-persisted',
      agentRuntime: 'copilot',
      config,
    })
    const contextSnapshot = {
      model: { ref: 'gpt-5.4-mini', provider: 'github-copilot', id: 'gpt-5.4-mini' },
      contextWindow: { tokens: 272_000, source: 'api_reported' as const },
      usage: { inputTokens: 9_261, totalTokens: 9_261 },
      breakdown: {
        system: 245,
        transcript: 2_294,
        tools: 6_719,
        memory: 3,
        attachments: 0,
        pendingUserInput: 0,
      },
      estimator: {
        total: { kind: 'provider_reported' as const, confidence: 'exact' as const },
        breakdown: { kind: 'heuristic' as const, confidence: 'estimated' as const },
        version: 'copilot-sdk-usage-info-v1',
      },
      updatedAt: Date.now(),
    }

    await store.updateRuntimeContextSnapshot(record, contextSnapshot)
    const reloaded = await new SessionStore(dir).load(record.sessionId)

    expect(reloaded.runtimeContextSnapshot).toEqual(contextSnapshot)
  })
})

describe('SessionStore.listSummaries', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-summary-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('uses loaded records for summaries and preserves current state fields', async () => {
    const store = new SessionStore(dir)
    const { record } = await store.ensure({
      sessionId: 'sess-loaded-summary',
      defaultConfig: config,
      workspaceId: 'ws-1',
      workspaceName: 'workstation',
      initialCwd: '/repo',
    })

    const [summary] = await store.listSummaries()

    expect(summary).toMatchObject({
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      eventCount: record.state.cursor,
      workspaceId: 'ws-1',
      workspaceName: 'workstation',
      currentCwd: '/repo',
      status: record.state.status,
    })
    expect(summary?.lastEventAt).toBeUndefined()
  })

  it('keeps the first user message as the title after state replacement and reload', async () => {
    const store = new SessionStore(dir)
    const { record } = await store.ensure({
      sessionId: 'sess-compacted-summary',
      defaultConfig: config,
    })
    const afterFirstMessage = {
      ...record.state,
      cursor: record.state.cursor + 1,
      messages: [
        ...record.state.messages,
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'original user request' }] },
      ],
    }
    await store.record(
      record.sessionId,
      { kind: 'user_message', text: 'original user request' },
      [],
      afterFirstMessage,
    )
    await store.record(
      record.sessionId,
      {
        kind: 'messages_replaced',
        reason: 'compaction',
        replaceRange: { start: 1, end: 2 },
        replacementMessages: [
          { role: 'user', content: [{ type: 'text', text: 'Another LLM produced a summary' }] },
        ],
      },
      [],
      {
        ...afterFirstMessage,
        cursor: afterFirstMessage.cursor + 1,
        messages: [
          record.state.messages[0]!,
          { role: 'user', content: [{ type: 'text', text: 'Another LLM produced a summary' }] },
        ],
      },
    )

    const [summary] = await store.listSummaries()
    const reloaded = await new SessionStore(dir).load(record.sessionId, { recoverDangling: false })

    expect(summary?.firstUserMessage).toBe('original user request')
    expect(reloaded.firstUserMessage).toBe('original user request')
  })

  it('reuses cached disk summaries until a log changes', async () => {
    const store = new SessionStore(dir)
    const sessionId = 'sess-disk-summary'
    const path = join(dir, `2026-07-05T00-00-00.000Z_${sessionId}.jsonl`)
    await writeHeader({
      path,
      sessionId,
      config,
      initialState: createInitialState({ sessionId, systemPrompt: 'sys' }),
    })

    const [first] = await store.listSummaries()
    const [second] = await store.listSummaries()

    expect(second).toBe(first)
    await vi.waitFor(() => expect(existsSync(`${path}.summary.json`)).toBe(true))

    const restarted = new SessionStore(dir)
    const [persisted] = await restarted.listSummaries()
    expect(persisted).toEqual(first)

    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'fresh task' },
      effects: [],
    })

    const [third] = await store.listSummaries()
    expect(third).not.toBe(first)
    expect(third?.firstUserMessage).toBe('fresh task')
  })

  it('summarizes external Sessions without parsing superseded snapshots', async () => {
    const sessionId = 'external-bounded-summary'
    const path = join(dir, `2026-07-05T00-00-01.000Z_${sessionId}.jsonl`)
    const initialState = createInitialState({ sessionId, systemPrompt: 'sys' })
    await writeHeader({
      path,
      sessionId,
      agentRuntime: 'copilot',
      config,
      initialState,
    })
    appendFileSync(path, '{"kind":"snapshot","ignored":"historical invalid snapshot"\n', 'utf8')
    appendFileSync(path, '{"kind":"runtime_metadata","malformed":"legacy payload"\n', 'utf8')
    await appendSnapshotEntry(path, 1, {
      ...initialState,
      cursor: 1,
      status: 'done',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'latest external request' }] }],
    })

    const [summary] = await new SessionStore(dir).listSummaries()

    expect(summary).toMatchObject({
      sessionId,
      agentRuntime: 'copilot',
      eventCount: 1,
      firstUserMessage: 'latest external request',
      status: 'done',
    })
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
    // NO tool_result — simulating the host crashing after dispatching the
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

    // Session is settled again — the reducer flowed tool_result → thinking
    // (because pendingCalls emptied out) → but with no follow-up LLM call
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
    expect(lastEvent.effects.map((e) => e.kind)).toEqual(['call_llm'])
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
    expect(parsed.events[2]!.effects.map((e) => e.kind)).toEqual(['call_tool'])
    expect(parsed.events[3]!.event.kind).toBe('tool_result')
    expect(parsed.events[3]!.effects.map((e) => e.kind)).toEqual(['call_llm'])
  })

  it('closes a session that was mid-stream (thinking) when the host died', async () => {
    // Host issued call_llm and died before the response returned. On disk we
    // see user_message → status=thinking → nothing else. Without recovery the
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
    expect(parsed.events[1]!.effects.map((e) => e.kind)).toEqual(['finish'])
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

  it('can load a graceful restart session without crash recovery side effects', async () => {
    const sessionId = 'sess-graceful-pending-tool'
    const path = join(dir, `2026-07-05T00-00-03.000Z_${sessionId}.jsonl`)
    const cfg = createConfig({ tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' }, requiresApproval: false }], systemPrompt: 'sys' })
    const initial = createInitialState({ sessionId, systemPrompt: 'sys' })
    await writeHeader({ path, sessionId, config: cfg, initialState: initial })
    await appendEventEntry({
      path,
      seq: 1,
      event: { kind: 'user_message', text: 'read' },
      effects: [{ kind: 'call_llm', messages: [], tools: cfg.tools }],
    })
    await appendEventEntry({
      path,
      seq: 2,
      event: {
        kind: 'llm_response',
        message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'c1', name: 'read', input: {} }] },
      },
      effects: [{ kind: 'call_tool', callId: 'c1', name: 'read', input: {} }],
    })

    const graceful = await new SessionStore(dir).load(sessionId, { recoverDangling: false })
    expect(graceful.state.status).toBe('executing_tools')
    expect(graceful.state.pendingCalls).toHaveLength(1)
    expect((await readSessionLog(path)).events).toHaveLength(2)

    const recovered = await new SessionStore(dir).load(sessionId)
    expect(recovered.state.pendingCalls).toEqual([])
    expect((await readSessionLog(path)).events).toHaveLength(3)
  })

  it('repairs a cached mid-stream session without forcing a disk reload', async () => {
    const sessionId = 'sess-cached-thinking'
    const cfg = createConfig({ tools: [], systemPrompt: 'sys' })
    const store = new SessionStore(dir)
    const rec = await store.create({ sessionId, config: cfg })
    const event = { kind: 'user_message', text: 'hello' } as const
    const { next, effects } = step(rec.state, event, rec.config)
    await store.record(sessionId, event, effects, next)

    const recovered = await store.recoverInterruptedLlm(sessionId)

    expect(recovered).not.toBeNull()
    expect(recovered?.record).toBe(rec)
    expect(rec.state.status).toBe('done')
    expect(rec.state.cursor).toBe(2)

    const parsed = await readSessionLog(rec.logPath)
    expect(parsed.events).toHaveLength(2)
    expect(parsed.events[1]!.event.kind).toBe('llm_response')
  })

  it('rejects concurrent stale transitions instead of appending duplicate cursors', async () => {
    const sessionId = 'sess-concurrent-record'
    const store = new SessionStore(dir)
    const record = await store.create({ sessionId, config })
    const firstEvent = { kind: 'user_message', text: 'first' } as const
    const secondEvent = { kind: 'user_message', text: 'second' } as const
    const first = step(record.state, firstEvent, record.config)
    const second = step(record.state, secondEvent, record.config)

    const settled = await Promise.allSettled([
      store.record(sessionId, firstEvent, first.effects, first.next),
      store.record(sessionId, secondEvent, second.effects, second.next),
    ])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(String(rejected?.reason)).toContain('stale Session transition')
    const parsed = await readSessionLog(record.logPath)
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0]?.seq).toBe(1)
    expect(record.state.cursor).toBe(1)
  })
})
