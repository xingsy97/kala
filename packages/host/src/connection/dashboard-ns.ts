/**
 * Dashboard Socket.IO namespace wiring.
 *
 * One socket per connected browser tab. The connection is bound to a
 * `sessionId` at handshake time (via `auth.sessionId`); the browser sees
 * `session:ready` up front and subscribes to a room named `session:<id>`.
 *
 * Every `client:*` event on this namespace maps to a call into the host
 * loop, the session store, or the executor registry. Nothing here decides
 * *what* the kernel does — that stays in the kernel. This file is protocol
 * mapping only.
 */

import type {
  ClientCancel,
  ClientCancelStream,
  ClientClear,
  ClientCompact,
  ClientConsolidateMemory,
  ClientCreateSession,
  ClientDeleteSession,
  ClientFork,
  ClientInterruptSubAgent,
  ClientKillBgTask,
  ClientListAgentTypes,
  ClientListBgTasks,
  ClientListDirs,
  ClientListExecutors,
  ClientListFiles,
  ClientListSessions,
  ClientListSubAgents,
  ClientLoadHistory,
  ClientLoadLogArtifact,
  ClientReadBgOutput,
  ClientReadOverflow,
  ClientDeleteQueuedMessage,
  ClientReorderQueuedMessage,
  ClientRenameWorkspace,
  ClientRenameSession,
  ClientSetApprovalMode,
  ClientSetCwd,
  ClientTerminalCreate,
  ClientTerminalInput,
  ClientTerminalKill,
  ClientTerminalResize,
  ClientUpdateQueuedMessage,
  ClientSubscribe,
  ClientUnsubscribe,
  ClientSubscribeChannels,
  ClientUnsubscribeChannels,
  ChannelSubscriptionResult,
  DashboardChannel,
  ClientUserApprove,
  ClientUserMessage,
  ClientUserReject,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  RpcAck,
  EventAppendedEvent,
  CompactionMetadata,
  HandshakeAuth,
  AttachedExecutor,
  ServerHistoryPayload,
  ServerMessageQueueEvent,
  SessionErrorScope,
  SessionReadyEvent,
  SubAgentSummary,
} from '@agent-kernel/shared'
import { isCompatibleVersion, schema, validateClientMessagePayload, validateInlineMessageImages } from '@agent-kernel/shared'
import type { RuntimeMetadataEntry } from '@agent-kernel/shared'
import type { SessionSummary } from '@agent-kernel/shared'
import type {
  WorkspaceExecRequest,
  WorkspaceReadBinaryRequest,
} from '@agent-kernel/shared/workspace-exec'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  MessageContent,
} from '@agent-kernel/kernel'
import { createInitialState, fold } from '@agent-kernel/kernel'
import type { Namespace } from 'socket.io'
import { ulid } from 'ulid'

import type { HostLoopDeps, LoopHandle } from '../loop.js'
import { consolidateMemory, type ConsolidationOutcome } from '../extensions/memory-consolidation.js'
import { markSubAgentInterrupted } from '../extensions/agent-tool.js'
import { resetCompactRuntime } from '../extensions/compaction.js'
import { readSessionLog } from '../store/log.js'
import { SessionStore, type SessionRecord } from '../store/session.js'
import { createExecutorRegistry } from './executor.js'
import { dirname, resolve as resolvePath, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AuthConfig } from '../auth-control.js'
import { authenticateDashboardHandshake } from '../auth-control.js'
import type { AuditActor, AuditLogger } from '../audit-log.js'
import { parseWire, type WireValidationContext } from '../wire-validation.js'
import { isSkillManager } from '../extensions/skills.js'
import { contextSnapshot, snapshotFromConfig, type ContextWindowOverride } from '../context/manager.js'
import { sessionRoom } from './rooms.js'
import { dashboardConnectionMeta, type ConnectionMeta } from './socket-metadata.js'
import { OperationDeduper } from './operation-deduper.js'

export type QueuedUserMessage = {
  id: string
  /** Client operation identity; stable across ACK loss and reconnect retry. */
  operationId: string
  text: string
  mode: 'steer' | 'queue'
  createdAt: string
  content?: readonly MessageContent[]
  model?: string
}

export type MessageQueueManager = {
  hydrate(sessionId: string): Promise<void>
  isStable(): boolean
  waitForStable(): Promise<void>
  enqueue(sessionId: string, msg: QueuedUserMessage, priority?: 'front'): Promise<void>
  reorder(sessionId: string, id: string, beforeId?: string | null): Promise<void>
  update(sessionId: string, id: string, text: string, content?: readonly MessageContent[]): Promise<void>
  delete(sessionId: string, id: string): Promise<void>
  /** Stop control: discard queued steers and pause ordinary follow-ups until the next explicit send. */
  stop(sessionId: string): Promise<void>
  pending(sessionId: string): number
  snapshot(sessionId: string): ServerMessageQueueEvent
  drain(sessionId: string): Promise<void>
}

export type DashboardNs = Namespace<
  DashboardClientToServerEvents,
  DashboardServerToClientEvents
>

export function isRestingStatus(status: AgentState['status']): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

export type DashboardDeps = {
  store: SessionStore
  loop: LoopHandle
  loopDeps: HostLoopDeps
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig | (() => AgentConfig)
  auth?: AuthConfig
  audit?: AuditLogger
  allowAllApprovalMode?: boolean
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
  contextWindowForModel?(model: string | undefined): ContextWindowOverride | undefined
  effectiveDefaultModel?(): string | undefined
  effectiveModelForSession?(record: SessionRecord): string | undefined
  normalizeModelRef?(model: string): string | undefined
  dashboardNs: DashboardNs
  messageQueues: MessageQueueManager
  executorSnapshot?(): readonly AttachedExecutor[]
  onSessionCreated?(record: SessionRecord): void | Promise<void>
  onSessionDeleted?(record: SessionRecord): void | Promise<void>
  renameWorkspace?(workspaceId: string, workspaceName: string): Promise<string>
  mutableReady?(): boolean
}

const READ_ONLY_DASHBOARD_EVENTS = new Set([
  'client:connection_ping', 'client:executor_ping', 'client:list_executors', 'client:list_sessions',
  'client:load_history', 'client:load_log_artifact', 'client:subscribe_channels', 'client:restore_subscriptions',
  'client:unsubscribe_channels', 'subscribe', 'unsubscribe', 'client:list_dirs', 'client:list_files',
  'workspace:read_binary', 'client:read_overflow', 'bg:list', 'bg:output', 'sub_agent:list', 'agent_types:list',
])

export function configureDashboardNamespace(
  ns: DashboardNs,
  deps: DashboardDeps,
): void {
  const operations = new OperationDeduper()
  const getDefaultConfig = (): AgentConfig => typeof deps.defaultConfig === 'function'
    ? deps.defaultConfig()
    : deps.defaultConfig
  const mutableRuntimeReady = (): boolean => deps.mutableReady?.() !== false
  ns.use((socket, nextFn) => {
    const auth = socket.handshake.auth as HandshakeAuth | undefined
    if (!auth || auth.role !== 'dashboard') {
      nextFn(new Error('role_mismatch'))
      return
    }
    if (typeof auth.clientVersion !== 'string' || !isCompatibleVersion(auth.clientVersion)) {
      nextFn(new Error('version_incompatible'))
      return
    }
    const authResult = authenticateDashboardHandshake(auth, socket.request, deps.auth)
    if (!authResult.ok) {
      deps.audit?.log({ action: 'dashboard.socket_reject', actor: { kind: 'anonymous' }, target: { sessionId: auth.sessionId }, outcome: 'denied', error: authResult.reason })
      nextFn(new Error(authResult.reason))
      return
    }
    if (!auth.sessionId && !auth.clientId) {
      nextFn(new Error('missing_connection_identity'))
      return
    }
    const connectionMeta = dashboardConnectionMeta({
      actor: authResult.actor,
      clientVersion: auth.clientVersion,
    })
    socket.data.dashboardActor = authResult.actor
    socket.data.readOnly = authResult.actor.kind === 'ingress' && authResult.actor.role === 'viewer'
    socket.data.connectionMeta = connectionMeta
    deps.audit?.log({ action: 'dashboard.socket_accept', actor: authResult.actor, target: { sessionId: auth.sessionId }, outcome: 'ok', metadata: auditConnectionMeta(connectionMeta) })
    nextFn()
  })

  ns.on('connection', async (socket) => {
    const auth = socket.handshake.auth as HandshakeAuth
    const multiplexed = Boolean(auth.clientId)
    // Legacy clients bind transport to one Session; multiplexed clients use a control placeholder until subscribing.
    const sessionId = auth.sessionId ?? `control:${auth.clientId}`
    socket.use(([event, ...args], next) => {
      if (deps.mutableReady?.() === false && !READ_ONLY_DASHBOARD_EVENTS.has(String(event))) {
        const ack = args.at(-1)
        if (typeof ack === 'function') (ack as (value: RpcAck) => void)({ ok: false, error: 'runtime_not_ready' })
        next(new Error('runtime_not_ready'))
        return
      }
      next()
    })
    socket.on('client:connection_ping', (_sentAt, ack) => ack(Date.now()))

    // Local `vparse` — closes over `socket.id` + the connected sessionId so
    // handlers can call `vparse(schema.X, raw, 'client:x')` in one line.
    const vparse = <T>(
      s: import('zod').ZodType<T>,
      raw: unknown,
      channel: string,
      overrideSessionId?: string,
    ): T | undefined => {
      const ctx: WireValidationContext = {
        channel,
        peer: socket.id,
        sessionId: overrideSessionId ?? sessionId,
      }
      return parseWire(s, raw, ctx)
    }
    const subscribedSessions = new Set<string>()
    const subscribedWorkspaces = new Set<string>()
    socket.on('client:executor_ping', async (workspaceId, ack) => {
      if (multiplexed && !subscribedWorkspaces.has(workspaceId)) { ack({ error: 'workspace is not subscribed' }); return }
      ack(await deps.executors.measureLatency(workspaceId))
    })
    const validateBgSessionAccess = async (targetSessionId: string, workspaceId: string): Promise<string | undefined> => {
      if (multiplexed ? !subscribedSessions.has(targetSessionId) : targetSessionId !== sessionId) {
        return 'This workspace operation belongs to an unsubscribed session.'
      }
      if (multiplexed && !subscribedWorkspaces.has(workspaceId)) return 'workspace is not subscribed'

      const record = deps.store.get(targetSessionId) ?? (await deps.store.load(targetSessionId, { recoverDangling: false }).catch(() => undefined))
      if (!record) return 'unknown session'
      if (record.workspaceId !== workspaceId) return 'session does not belong to workspace'
      return undefined
    }
    const auditScopedAccessDenied = (action: string, targetSessionId: string, workspaceId: string, error: string): void => {
      deps.audit?.log({ action, actor: auditActor(socket), target: { sessionId: targetSessionId, workspaceId }, outcome: 'denied', error })
    }
    if (socket.data.readOnly === true) {
      const writeEvents = [
        'client:user_message', 'client:user_approve', 'client:user_reject', 'client:cancel', 'client:interrupt_sub_agent',
        'client:clear', 'client:compact', 'client:cancel_stream', 'client:set_approval_mode', 'client:fork',
        'client:create_session', 'client:delete_session', 'client:update_preferences', 'client:set_cwd',
        'client:reorder_queued_message', 'client:update_queued_message', 'client:delete_queued_message',
        'client:rename_session', 'client:rename_workspace', 'client:consolidate_memory', 'bg:kill',
        'terminal:create', 'terminal:input', 'terminal:resize', 'terminal:kill', 'workspace:exec',
      ] as const
      socket.use(([event, ...args], next) => {
        if (!writeEvents.includes(event as typeof writeEvents[number])) { next(); return }
        const ack = args.at(-1)
        if (typeof ack === 'function') (ack as (value: { ok: false; error: string }) => void)({ ok: false, error: 'forbidden: runtime:write required' })
        deps.audit?.log({ action: `dashboard.${event}`, actor: auditActor(socket), outcome: 'denied', error: 'runtime:write required' })
        next(new Error('forbidden: runtime:write required'))
      })
    }

    // Register first-paint request handlers before any awaited session load.
    // The dashboard emits these immediately after the websocket connects or
    // after `session:ready`; if we install handlers later, those one-shot
    // requests can be lost and the UI stays on "no session selected".
    socket.on('client:list_executors', (raw: ClientListExecutors) => {
      if (!vparse(schema.ClientListExecutorsSchema, raw, 'client:list_executors')) return
      socket.emit('server:executors', { executors: executorSnapshotFor(deps) })
    })

    socket.on('client:list_sessions', async (raw: ClientListSessions) => {
      if (!vparse(schema.ClientListSessionsSchema, raw, 'client:list_sessions')) return
      const sessions = withQueuedCounts(deps, await deps.store.listSummaries())
      socket.emit('server:sessions', { sessions })
    })

    socket.on('client:load_history', async (raw: ClientLoadHistory) => {
      const p = vparse(schema.ClientLoadHistorySchema, raw, 'client:load_history', (raw as ClientLoadHistory | undefined)?.sessionId)
      if (!p) return
      try {
        let target: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!target) {
          try {
            target = await deps.store.load(p.sessionId, { recoverDangling: false })
          } catch {
            // Session hasn't been persisted yet — reply with an empty
            // history rather than broadcasting an error the dashboard would
            // render as a red banner. This is the expected state for a
            // freshly-connected new session.
            const empty: ServerHistoryPayload = {
              sessionId: p.sessionId,
              entries: [],
            }
            socket.emit('server:history', empty)
            return
          }
        }
        const parsed = await readSessionLog(target.logPath)
        const since = p.sinceCursor ?? 0
        const compactionMetadataByReplaceRange = buildCompactionMetadataIndex(parsed.runtimeMetadata)
        const entries: EventAppendedEvent[] = parsed.events
          .filter((e) => e.seq > since)
          .map((e) => {
            const meta =
              e.event.kind === 'messages_replaced' && e.event.reason === 'compaction'
                ? consumeCompactionMetadata(compactionMetadataByReplaceRange, e.event.replaceRange)
                : undefined
            return {
              sessionId: p.sessionId,
              seq: e.seq,
              ts: e.ts,
              event: e.event,
              effects: e.effects,
              ...(e.effectsArtifact ? { hasEffectsArtifact: true } : {}),
              ...(e.llmTraceArtifact ? { hasLlmTraceArtifact: true } : {}),
              ...(e.llmTrace ? { llmTrace: e.llmTrace } : {}),
              ...(e.model ? { model: e.model } : {}),
              ...(e.timing ? { timing: e.timing } : {}),
              ...(meta ? { compactionMetadata: meta } : {}),
            }
          })
        const payload: ServerHistoryPayload = { sessionId: p.sessionId, entries }
        socket.emit('server:history', payload)
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:load_log_artifact', async (raw: ClientLoadLogArtifact) => {
      const p = vparse(schema.ClientLoadLogArtifactSchema, raw, 'client:load_log_artifact', (raw as ClientLoadLogArtifact | undefined)?.sessionId)
      if (!p) return
      try {
        let target: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!target) target = await deps.store.load(p.sessionId, { recoverDangling: false })
        const parsed = await readSessionLog(target.logPath)
        const entry = parsed.events.find((e) => e.seq === p.seq)
        if (!entry) {
          socket.emit('server:log_artifact', { sessionId: p.sessionId, seq: p.seq, error: 'event not found' })
          return
        }
        const payload: { effects?: unknown; llmTrace?: unknown } = {}
        if (entry.effectsArtifact) {
          payload.effects = await readJsonLogArtifact(target.logPath, entry.effectsArtifact.path)
        }
        if (entry.llmTraceArtifact) {
          payload.llmTrace = await readJsonLogArtifact(target.logPath, entry.llmTraceArtifact.path)
        } else if (entry.llmTrace) {
          payload.llmTrace = entry.llmTrace
        }
        socket.emit('server:log_artifact', {
          sessionId: p.sessionId,
          seq: p.seq,
          ...(payload.effects ? { effects: payload.effects as never } : {}),
          ...(payload.llmTrace ? { llmTrace: payload.llmTrace as never } : {}),
        })
      } catch (err) {
        socket.emit('server:log_artifact', {
          sessionId: p.sessionId,
          seq: p.seq,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    const channelTails = new Map<DashboardChannel, Promise<void>>()
    const channelGenerations = new Map<DashboardChannel, number>()
    const serializeChannel = async <T>(channel: DashboardChannel, operation: () => Promise<T>): Promise<T> => {
      const previous = channelTails.get(channel) ?? Promise.resolve()
      let result!: T
      const current = previous.catch(() => undefined).then(async () => { result = await operation() })
      channelTails.set(channel, current)
      try { await current; return result } finally { if (channelTails.get(channel) === current) channelTails.delete(channel) }
    }

    const subscribeSession = async (targetSessionId: string): Promise<number> => {
      let target = deps.store.get(targetSessionId)
      if (!target) try { target = await deps.store.load(targetSessionId, { recoverDangling: false, runtimeConfig: getDefaultConfig() }) } catch { target = undefined }
      if (target) await refreshSessionSkillsIfNeeded(deps, target)
      await socket.join(sessionRoom(targetSessionId))
      subscribedSessions.add(targetSessionId)
      await deps.messageQueues.hydrate(targetSessionId)
      const defaultModel = effectiveDefaultModel(deps)
      const payload: SessionReadyEvent = target
        ? readyEventFor(target, effectiveModelForRecord(deps, target), 'load', contextWindowForSession(deps, target))
        : ephemeralReadyEventFor(targetSessionId, getDefaultConfig(), defaultModel, contextWindowForModelRef(deps, defaultModel))
      socket.emit('session:ready', payload)
      socket.emit('server:message_queue', deps.messageQueues.snapshot(targetSessionId))
      // Candidate sockets may inspect the authoritative state during private
      // verification, but only the RestartCoordinator owns continuation before
      // the route-generation fence is publicly committed. A read subscription
      // must never become a second resume/drain path.
      if (mutableRuntimeReady()) {
        if (target && !isRestingStatus(target.state.status)) void deps.loop.resumeSession(targetSessionId)
        void deps.messageQueues.drain(targetSessionId)
      }
      return payload.cursor
    }

    const channelResult = async (raw: ClientSubscribeChannels | ClientUnsubscribeChannels, remove: boolean): Promise<ChannelSubscriptionResult | undefined> => {
      const parsed = remove ? vparse(schema.ClientUnsubscribeChannelsSchema, raw, 'client:unsubscribe_channels') : vparse(schema.ClientSubscribeChannelsSchema, raw, 'client:subscribe_channels')
      if (!parsed) return undefined
      const accepted: DashboardChannel[] = [], rejected: Array<{ channel: DashboardChannel; code: string }> = [], cursors: Record<string, number> = {}
      const uniqueChannels = [...new Set(parsed.channels)]
      if (uniqueChannels.length > 128 || subscribedSessions.size + subscribedWorkspaces.size + uniqueChannels.length > 256) {
        return { requestId: parsed.requestId, generation: parsed.generation, accepted, rejected: uniqueChannels.map((channel) => ({ channel, code: 'subscription_limit' })), cursors }
      }
      for (const channel of uniqueChannels) {
        if (channel === 'global') { accepted.push(channel); continue }
        const [kind, id] = channel.split(':', 2) as ['workspace' | 'session', string]
        if (!id) { rejected.push({ channel, code: 'invalid_channel' }); continue }
        await serializeChannel(channel, async () => {
          const latestGeneration = channelGenerations.get(channel) ?? Number.NEGATIVE_INFINITY
          if (parsed.generation < latestGeneration) { rejected.push({ channel, code: 'stale_generation' }); return }
          channelGenerations.set(channel, parsed.generation)
          if (kind === 'workspace') { if (remove) subscribedWorkspaces.delete(id); else subscribedWorkspaces.add(id); accepted.push(channel); return }
          if (remove) { subscribedSessions.delete(id); await socket.leave(sessionRoom(id)); accepted.push(channel); return }
          // Every successful subscribe emits a fresh baseline, even when this
          // socket was already in the room. A new client-side selection
          // generation must never wait on a one-shot ready event from an older
          // binding.
          cursors[channel] = await subscribeSession(id); accepted.push(channel)
        })
      }
      return { requestId: parsed.requestId, generation: parsed.generation, accepted, rejected, cursors }
    }
    socket.on('client:subscribe_channels', async (raw, ack) => ack((await channelResult(raw, false)) ?? { requestId: raw.requestId, generation: raw.generation, accepted: [], rejected: [], cursors: {} }))
    socket.on('client:restore_subscriptions', async (raw, ack) => ack((await channelResult(raw, false)) ?? { requestId: raw.requestId, generation: raw.generation, accepted: [], rejected: [], cursors: {} }))
    socket.on('client:unsubscribe_channels', async (raw, ack) => ack((await channelResult(raw, true)) ?? { requestId: raw.requestId, generation: raw.generation, accepted: [], rejected: [], cursors: {} }))

    if (!multiplexed) {
    // Do NOT auto-create the session on connect. A dashboard opening a fresh
    // random UUID must not materialize a JSONL file on disk — otherwise
    // "click New" and "delete last session" both silently resurrect an empty
    // session behind the user's back. Lazy-create instead: the first
    // dispatched user event (`client:user_message` / `client:fork`) is what
    // commits a session to disk. Until then the dashboard sees an ephemeral
    // initial state.
    let record: SessionRecord | undefined = deps.store.get(sessionId)
    if (!record) {
      try {
        // Do not convert a dangling `thinking` state into a terminal
        // `[interrupted]` response during reconnect. The Loop resumes that
        // state below; eager Store recovery would end the turn first.
        record = await deps.store.load(sessionId, { recoverDangling: false })
      } catch {
        record = undefined
      }
    }
    if (record) await refreshSessionSkillsIfNeeded(deps, record)
    await socket.join(sessionRoom(sessionId))
    await deps.messageQueues.hydrate(sessionId)
    const defaultModel = effectiveDefaultModel(deps)
    const ready: SessionReadyEvent = record
      ? readyEventFor(record, effectiveModelForRecord(deps, record), 'load', contextWindowForSession(deps, record))
        : ephemeralReadyEventFor(
          sessionId,
          getDefaultConfig(),
          defaultModel,
          contextWindowForModelRef(deps, defaultModel),
        )
    socket.emit('session:ready', ready)
    socket.emit('server:message_queue', deps.messageQueues.snapshot(sessionId))
    // A service-manager restart has no persisted RestartCoordinator marker for
    // the active turn. Resume any dangling LLM/tool state on first hydration;
    // resumeSession is idempotent while a live serialized turn exists.
    if (mutableRuntimeReady()) {
      if (record && !isRestingStatus(record.state.status)) void deps.loop.resumeSession(sessionId)
      void deps.messageQueues.drain(sessionId)
    }

    const desiredPreviewSessions = new Set<string>()
    socket.on('subscribe', async (raw: ClientSubscribe) => {
      const p = vparse(schema.ClientSubscribeSchema, raw, 'subscribe', (raw as ClientSubscribe | undefined)?.sessionId)
      if (!p) return
      const { sessionId } = p
      desiredPreviewSessions.add(sessionId)
      let target = deps.store.get(sessionId)
      if (!target) {
        try {
          target = await deps.store.load(sessionId, { recoverDangling: false, runtimeConfig: getDefaultConfig() })
        } catch {
          target = undefined
        }
      }
      if (target) {
        await refreshSessionSkillsIfNeeded(deps, target)
      }
      if (!desiredPreviewSessions.has(sessionId)) return
      await socket.join(sessionRoom(sessionId))
      await deps.messageQueues.hydrate(sessionId)
      const defaultModel = effectiveDefaultModel(deps)
      const payload: SessionReadyEvent = target
        ? readyEventFor(target, effectiveModelForRecord(deps, target), 'load', contextWindowForSession(deps, target))
        : ephemeralReadyEventFor(
            sessionId,
            getDefaultConfig(),
            defaultModel,
            contextWindowForModelRef(deps, defaultModel),
          )
      socket.emit('session:ready', payload)
      socket.emit('server:message_queue', deps.messageQueues.snapshot(sessionId))
      if (mutableRuntimeReady()) {
        if (target && !isRestingStatus(target.state.status)) void deps.loop.resumeSession(sessionId)
        void deps.messageQueues.drain(sessionId)
      }
    })

    socket.on('unsubscribe', async (raw: ClientUnsubscribe) => {
      const p = vparse(schema.ClientUnsubscribeSchema, raw, 'unsubscribe', (raw as ClientUnsubscribe | undefined)?.sessionId)
      if (!p || p.sessionId === sessionId) return
      desiredPreviewSessions.delete(p.sessionId)
      await socket.leave(sessionRoom(p.sessionId))
    })

    }

    socket.on('client:user_message', async (raw: ClientUserMessage, ack) => {
      const payloadError = validateClientMessagePayload(raw)
      if (payloadError) { ack?.({ ok: false, error: `${payloadError.code}: ${payloadError.message}` }); return }
      const p = vparse(schema.ClientUserMessageSchema, raw, 'client:user_message', (raw as ClientUserMessage | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'INVALID_MESSAGE: invalid payload' }); return }
      const imageValidation = validateInlineMessageImages(p.content)
      if (!imageValidation.ok) { ack?.({ ok: false, error: `${imageValidation.error.code}: ${imageValidation.error.message}` }); return }
      const result = await operations.run(p.operationId, async () => {
        deps.audit?.log({ action: 'dashboard.user_message', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { messageBytes: Buffer.byteLength(p.text, 'utf8'), mode: p.mode ?? 'steer' } })
        await handleUserMessage(deps, p)
      })
      ack?.(result)
    })
    socket.on('client:user_approve', async (raw: ClientUserApprove) => {
      const p = vparse(schema.ClientUserApproveSchema, raw, 'client:user_approve', (raw as ClientUserApprove | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.user_approve', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok' })
      const evt: AgentEvent = { kind: 'user_approve', callId: p.callId }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:user_reject', async (raw: ClientUserReject) => {
      const p = vparse(schema.ClientUserRejectSchema, raw, 'client:user_reject', (raw as ClientUserReject | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.user_reject', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok', metadata: { reasonBytes: p.reason ? Buffer.byteLength(p.reason, 'utf8') : 0 } })
      const evt: AgentEvent = {
        kind: 'user_reject',
        callId: p.callId,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:cancel', async (raw: ClientCancel) => {
      const p = vparse(schema.ClientCancelSchema, raw, 'client:cancel', (raw as ClientCancel | undefined)?.sessionId)
      if (!p) return
      // Establish the queue boundary before cancelling the turn. Otherwise the
      // queue drainer can observe the resulting resting state and immediately
      // start a queued steer/follow-up, making Stop appear ineffective.
      await deps.messageQueues.stop(p.sessionId)
      const evt: AgentEvent = { kind: 'cancel' }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:interrupt_sub_agent', async (raw: ClientInterruptSubAgent) => {
      const p = vparse(schema.ClientInterruptSubAgentSchema, raw, 'client:interrupt_sub_agent')
      if (!p) return
      try {
        const result = markSubAgentInterrupted(p.parentSessionId, p.parentCallId, p.childSessionId)
        if (!result.ok) {
          deps.broadcastError(p.parentSessionId, 'host', result.error ?? 'sub-agent interrupt failed')
          return
        }
        await deps.loop.dispatch(result.childSessionId, { kind: 'cancel' })
      } catch (err) {
        deps.broadcastError(
          p.parentSessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:clear', async (raw: ClientClear) => {
      const p = vparse(schema.ClientClearSchema, raw, 'client:clear', (raw as ClientClear | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.session_clear', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok' })
      deps.loopDeps.tools.cancelPending(p.sessionId)
      deps.loop.cancelStream(p.sessionId)
      const evt: AgentEvent = { kind: 'clear' }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:compact', async (raw: ClientCompact) => {
      const p = vparse(schema.ClientCompactSchema, raw, 'client:compact', (raw as ClientCompact | undefined)?.sessionId)
      if (!p) return
      try {
        let record: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!record) {
          try {
            record = await deps.store.load(p.sessionId)
          } catch {
            record = undefined
          }
        }
        if (!record) {
          deps.broadcastError(
            p.sessionId,
            'host',
            'session not created — nothing to compact',
          )
          return
        }
        // Manual compaction is transcript maintenance. Persist the handoff but
        // leave the Session resting; only a later user message starts work.
        await deps.loop.compact(p.sessionId, { trigger: 'manual', continuation: 'stay_resting' })
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'kernel',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:cancel_stream', (raw: ClientCancelStream) => {
      const p = vparse(schema.ClientCancelStreamSchema, raw, 'client:cancel_stream', (raw as ClientCancelStream | undefined)?.sessionId)
      if (!p) return
      // No error path — cancelStream is a no-op when nothing is streaming.
      // The loop turns the abort into a normal llm_response, so the FSM
      // and log stay coherent without any special-case wiring here.
      deps.loop.cancelStream(p.sessionId)
    })
    socket.on('client:set_approval_mode', async (raw: ClientSetApprovalMode, ack?: (result: RpcAck) => void) => {
      const p = vparse(schema.ClientSetApprovalModeSchema, raw, 'client:set_approval_mode', (raw as ClientSetApprovalMode | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid approval mode request' }); return }
      // Host-owned guard rail. Portable and Dedicated composition enable this by
      // default; embedders may disable it explicitly. Executor installation and
      // environment never control Session approval policy.
      if (p.mode === 'allow_all' && deps.allowAllApprovalMode === false) {
        deps.audit?.log({ action: 'dashboard.approval_mode_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'denied', metadata: { mode: p.mode }, error: 'allow_all is disabled by the host' })
        deps.broadcastError(p.sessionId, 'host', 'approval mode "allow_all" is disabled by the host')
        ack?.({ ok: false, error: 'approval mode "allow_all" is disabled by the host' })
        return
      }
      const result = await operations.run(p.operationId, async () => {
        const record = await loadRecordForDashboard(deps, p.sessionId)
        if (!record) throw new Error('unknown session')
        await deps.loop.dispatch(p.sessionId, { kind: 'approval_mode_changed', mode: p.mode })
        // Changing to allow_all must also unblock calls already parked by the
        // previous mode; otherwise the selector appears to do nothing.
        if (p.mode === 'allow_all') {
          for (const call of record.state.pendingCalls) {
            if (call.status === 'awaiting_approval') {
              await deps.loop.dispatch(p.sessionId, { kind: 'user_approve', callId: call.callId })
            }
          }
        }
      })
      ack?.(result)
      deps.audit?.log({ action: 'dashboard.approval_mode_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: result.ok ? 'ok' : 'error', metadata: { mode: p.mode }, ...(!result.ok ? { error: result.error } : {}) })
    })
    socket.on('client:set_cwd', async (raw: ClientSetCwd) => {
      const p = vparse(schema.ClientSetCwdSchema, raw, 'client:set_cwd', (raw as ClientSetCwd | undefined)?.sessionId)
      if (!p) return
      const record = await loadRecordForDashboard(deps, p.sessionId)
      if (!record) {
        deps.broadcastError(p.sessionId, 'host', 'unknown session')
        return
      }
      if (!isRestingStatus(record.state.status)) {
        deps.broadcastError(
          p.sessionId,
          'host',
          `cannot change cwd while session status is ${record.state.status}`,
        )
        return
      }
      const validation = await validateSessionCwd(deps, record, p.cwd)
      if (!validation.ok) {
        deps.audit?.log({ action: 'dashboard.cwd_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'denied', metadata: { cwd: p.cwd }, error: validation.reason })
        deps.broadcastError(p.sessionId, 'host', validation.reason)
        return
      }
      await safeDispatch(deps, p.sessionId, {
        kind: 'cwd_changed',
        cwd: validation.cwd,
      })
      deps.audit?.log({ action: 'dashboard.cwd_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { cwd: validation.cwd } })
      await broadcastSessionList(deps)
    })
    socket.on('client:reorder_queued_message', async (raw: ClientReorderQueuedMessage, ack) => {
      const p = vparse(schema.ClientReorderQueuedMessageSchema, raw, 'client:reorder_queued_message', (raw as ClientReorderQueuedMessage | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid payload' }); return }
      const result = await operations.run(p.operationId, () => deps.messageQueues.reorder(p.sessionId, p.id, p.beforeId))
      ack?.(result)
    })
    socket.on('client:update_queued_message', async (raw: ClientUpdateQueuedMessage, ack) => {
      const p = vparse(schema.ClientUpdateQueuedMessageSchema, raw, 'client:update_queued_message', (raw as ClientUpdateQueuedMessage | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid payload' }); return }
      const result = await operations.run(p.operationId, () => deps.messageQueues.update(p.sessionId, p.id, p.text, p.content))
      ack?.(result)
    })
    socket.on('client:delete_queued_message', async (raw: ClientDeleteQueuedMessage, ack) => {
      const p = vparse(schema.ClientDeleteQueuedMessageSchema, raw, 'client:delete_queued_message', (raw as ClientDeleteQueuedMessage | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid payload' }); return }
      const result = await operations.run(p.operationId, () => deps.messageQueues.delete(p.sessionId, p.id))
      ack?.(result)
    })
    socket.on('client:rename_session', async (raw: ClientRenameSession) => {
      const p = vparse(schema.ClientRenameSessionSchema, raw, 'client:rename_session', (raw as ClientRenameSession | undefined)?.sessionId)
      if (!p) return
      try {
        const applied = await deps.store.rename(p.sessionId, p.label)
        deps.dashboardNs.emit('server:control_update', {
          kind: 'session_meta_changed',
          sessionId: p.sessionId,
          label: applied,
        })
        await broadcastSessionList(deps)
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:rename_workspace', async (raw: ClientRenameWorkspace) => {
      const p = vparse(schema.ClientRenameWorkspaceSchema, raw, 'client:rename_workspace')
      if (!p) return
      try {
        const applied = deps.renameWorkspace
          ? await deps.renameWorkspace(p.workspaceId, p.workspaceName)
          : p.workspaceName.trim()
        deps.dashboardNs.emit('server:control_update', {
          kind: 'workspace_meta_changed',
          workspaceId: p.workspaceId,
          workspaceName: applied,
        })
        deps.dashboardNs.emit('server:executors', { executors: executorSnapshotFor(deps) })
        await broadcastSessionList(deps)
      } catch (err) {
        deps.broadcastError(
          p.workspaceId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:list_dirs', async (raw: ClientListDirs) => {
      const p = vparse(schema.ClientListDirsSchema, raw, 'client:list_dirs') as ClientListDirs | undefined
      if (!p) return
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.list_dirs', p.sessionId, p.workspaceId, error)
          socket.emit('server:dir_list', { requestId: p.requestId, workspaceId: p.workspaceId, path: p.path ?? '', roots: [], entries: [], error })
          return
        }
      }
      deps.audit?.log({ action: 'internal_tool.list_dirs', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok', metadata: { path: p.path } })
      const result = await deps.executors.listDirs(p.workspaceId, p.path, p.requestId)
      socket.emit('server:dir_list', result)
    })
    socket.on('client:list_files', async (raw: ClientListFiles) => {
      const p = vparse(schema.ClientListFilesSchema, raw, 'client:list_files') as ClientListFiles | undefined
      if (!p) return
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.list_files', p.sessionId, p.workspaceId, error)
          socket.emit('server:file_list', { requestId: p.requestId, workspaceId: p.workspaceId, files: [], truncated: false, error })
          return
        }
      }
      const result = await deps.executors.listFiles(p)
      socket.emit('server:file_list', result)
    })
    // Generic dashboard-initiated workspace exec + binary read. See
    // docs/planning/roadmap-notes/workspace-exec-refactor.md for the
    // trust story: same sandbox rules as the agent-facing `bash`; the
    // difference is the actor (human at a dashboard button, not the LLM).
    // Audit records argv.slice(0, 3) so post-hoc review has a searchable
    // shape without unbounded metadata size.
    socket.on('workspace:exec', async (raw: WorkspaceExecRequest, ack) => {
      // No zod schema in shared yet; validate minimally by hand.
      if (!raw || typeof raw !== 'object' || typeof raw.requestId !== 'string' || typeof raw.workspaceId !== 'string' || !Array.isArray(raw.argv) || raw.argv.length === 0) {
        deps.audit?.log({ action: 'workspace.exec', actor: auditActor(socket), target: { workspaceId: raw?.workspaceId ?? 'unknown' }, outcome: 'denied', error: 'invalid payload' })
        return ack?.({ requestId: raw?.requestId ?? '', stdout: '', stderr: '', exitCode: null, durationMs: 0, error: { code: 'EINVAL', message: 'invalid payload' } })
      }
      if (multiplexed && !subscribedWorkspaces.has(raw.workspaceId)) {
        return ack?.({ requestId: raw.requestId, stdout: '', stderr: '', exitCode: null, durationMs: 0, error: { code: 'EACCES', message: 'workspace is not subscribed' } })
      }
      const argvHead = raw.argv.slice(0, 3).map((arg) => typeof arg === 'string' ? arg : String(arg))
      deps.audit?.log({
        action: 'workspace.exec',
        actor: auditActor(socket),
        target: { workspaceId: raw.workspaceId },
        outcome: 'ok',
        metadata: { argv: argvHead, cwd: raw.cwd ?? null },
      })
      const result = await deps.executors.workspaceExec(raw as WorkspaceExecRequest)
      ack?.(result)
    })
    socket.on('workspace:read_binary', async (raw: WorkspaceReadBinaryRequest, ack) => {
      if (!raw || typeof raw !== 'object' || typeof raw.requestId !== 'string' || typeof raw.workspaceId !== 'string' || typeof raw.path !== 'string') {
        deps.audit?.log({ action: 'workspace.read_binary', actor: auditActor(socket), target: { workspaceId: raw?.workspaceId ?? 'unknown' }, outcome: 'denied', error: 'invalid payload' })
        return ack?.({ requestId: raw?.requestId ?? '', base64: '', mime: 'application/octet-stream', size: 0, error: { code: 'EINVAL', message: 'invalid payload' } })
      }
      if (multiplexed && !subscribedWorkspaces.has(raw.workspaceId)) {
        return ack?.({ requestId: raw.requestId, base64: '', mime: 'application/octet-stream', size: 0, error: { code: 'EACCES', message: 'workspace is not subscribed' } })
      }
      deps.audit?.log({
        action: 'workspace.read_binary',
        actor: auditActor(socket),
        target: { workspaceId: raw.workspaceId },
        outcome: 'ok',
        metadata: { path: raw.path, cwd: raw.cwd ?? null },
      })
      const result = await deps.executors.workspaceReadBinary(raw as WorkspaceReadBinaryRequest)
      ack?.(result)
    })
    socket.on('client:read_overflow', async (raw: ClientReadOverflow) => {
      const p = vparse(schema.ClientReadOverflowSchema, raw, 'client:read_overflow', (raw as ClientReadOverflow | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'internal_tool.read_overflow', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok' })
      const record = deps.store.get(p.sessionId) ?? (await deps.store.load(p.sessionId, { recoverDangling: false }).catch(() => undefined))
      const workspaceId = record?.workspaceId
      if (!workspaceId) {
        socket.emit('server:overflow_contents', {
          requestId: p.requestId,
          sessionId: p.sessionId,
          callId: p.callId,
          error: 'unknown session or session has no workspace',
        })
        return
      }
      const result = await deps.executors.readOverflow(p, workspaceId)
      socket.emit('server:overflow_contents', result)
    })
    socket.on('bg:list', async (raw: ClientListBgTasks, ack) => {
      const p = vparse(schema.ClientListBgTasksSchema, raw, 'bg:list', (raw as ClientListBgTasks | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('background_task.list', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, tasks: [], error })
      }
      const result = await deps.executors.listBg(p)
      ack(result)
    })
    socket.on('bg:output', async (raw: ClientReadBgOutput, ack) => {
      const p = vparse(schema.ClientReadBgOutputSchema, raw, 'bg:output', (raw as ClientReadBgOutput | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('background_task.output', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, taskId: p.taskId, content: '', nextOffset: 0, done: true, status: 'exited', bytesTruncated: 0, error })
      }
      const result = await deps.executors.readBg(p)
      ack(result)
    })
    socket.on('bg:kill', async (raw: ClientKillBgTask, ack) => {
      const p = vparse(schema.ClientKillBgTaskSchema, raw, 'bg:kill', (raw as ClientKillBgTask | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('background_task.kill', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, taskId: p.taskId, killed: false, error })
      }
      const result = await deps.executors.killBg(p)
      ack(result)
    })
    socket.on('terminal:create', async (raw: ClientTerminalCreate, ack) => {
      const p = vparse(schema.ClientTerminalCreateSchema, raw, 'terminal:create', (raw as ClientTerminalCreate | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('terminal.create', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, error })
      }
      const result = await deps.executors.createTerminal(p)
      ack(result)
    })
    socket.on('terminal:input', async (raw: ClientTerminalInput) => {
      const p = vparse(schema.ClientTerminalInputSchema, raw, 'terminal:input', (raw as ClientTerminalInput | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('terminal.input', p.sessionId, p.workspaceId, error)
        return
      }
      deps.executors.inputTerminal(p)
    })
    socket.on('terminal:resize', async (raw: ClientTerminalResize) => {
      const p = vparse(schema.ClientTerminalResizeSchema, raw, 'terminal:resize', (raw as ClientTerminalResize | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('terminal.resize', p.sessionId, p.workspaceId, error)
        return
      }
      deps.executors.resizeTerminal(p)
    })
    socket.on('terminal:kill', async (raw: ClientTerminalKill, ack) => {
      const p = vparse(schema.ClientTerminalKillSchema, raw, 'terminal:kill', (raw as ClientTerminalKill | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('terminal.kill', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, terminalId: p.terminalId, killed: false, error })
      }
      const result = await deps.executors.killTerminal(p)
      ack(result)
    })
    socket.on('sub_agent:list', async (raw: ClientListSubAgents, ack) => {
      const p = vparse(schema.ClientListSubAgentsSchema, raw, 'sub_agent:list')
      if (!p) return
      const children: SubAgentSummary[] = []
      for (const rec of await deps.store.listChildren(p.parentSessionId)) {
        const status: SubAgentSummary['status'] =
          rec.state.status === 'done'
            ? 'completed'
            : rec.state.status === 'error'
              ? 'failed'
              : 'running'
        children.push({
          childSessionId: rec.sessionId,
          ...(rec.parentCallId !== undefined ? { parentCallId: rec.parentCallId } : {}),
          ...(rec.agentType !== undefined ? { agentType: rec.agentType } : {}),
          status,
          ...(rec.subAgentStartedAt !== undefined ? { startedAt: rec.subAgentStartedAt } : {}),
          ...(status !== 'running' && rec.lastEventAt !== undefined ? { finishedAt: rec.lastEventAt } : {}),
        })
      }
      ack({ requestId: p.requestId, parentSessionId: p.parentSessionId, children })
    })
    socket.on('agent_types:list', (raw: ClientListAgentTypes, ack) => {
      const p = vparse(schema.ClientListAgentTypesSchema, raw, 'agent_types:list')
      if (!p) return
      // Registry loader lives behind a follow-up (docs/host/sub-agent-design.md §6).
      // Return an empty list so dashboards that call this on mount don't crash;
      // the Composer '@agent-name' menu shows an empty state until the loader ships.
      ack({ requestId: p.requestId, types: [] })
    })
    socket.on('client:consolidate_memory', async (raw: ClientConsolidateMemory) => {
      const p = vparse(schema.ClientConsolidateMemorySchema, raw, 'client:consolidate_memory', (raw as ClientConsolidateMemory | undefined)?.sessionId)
      if (!p) return
      const outcome = await consolidateMemory(deps.loopDeps, p.sessionId).catch(
        (err: unknown): ConsolidationOutcome => ({
          saved: [],
          skipped: 0,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      const payload = {
        requestId: p.requestId,
        sessionId: p.sessionId,
        saved: outcome.saved,
        skipped: outcome.skipped,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      }
      socket.emit('server:memory_consolidated', payload)
    })
    socket.on('client:create_session', async (raw: ClientCreateSession, ack) => {
      const parsed = vparse(schema.ClientCreateSessionSchema, raw, 'client:create_session', (raw as ClientCreateSession | undefined)?.sessionId)
      if (!parsed) { ack?.({ ok: false, error: 'invalid payload' }); return }
      let p: ClientCreateSession = parsed
      try {
        const selectedModel = p.selectedModel?.trim()
        const normalizedSelectedModel = selectedModel ? normalizeIncomingModel(deps, selectedModel) : undefined
        if (selectedModel && !normalizedSelectedModel) {
          const message = `unknown or ambiguous model: ${selectedModel}`
          socket.emit('session:error', { sessionId: p.sessionId, scope: 'host', message })
          ack?.({ ok: false, error: message })
          return
        }
        const cwd = p.cwd?.trim()
        if (cwd && cwd.length > 0 && p.workspaceId) {
          const validation = await validateWorkspaceCwd(deps, p.workspaceId, cwd)
          if (!validation.ok) {
            deps.audit?.log({ action: 'dashboard.session_create', actor: auditActor(socket), target: { sessionId: p.sessionId, workspaceId: p.workspaceId }, outcome: 'denied', metadata: { cwd }, error: validation.reason })
            socket.emit('session:error', {
              sessionId: p.sessionId,
              scope: 'host',
              message: validation.reason,
            })
            return
          }
          p = { ...p, cwd: validation.cwd }
        }
        const { record, created } = await deps.store.ensure({
          sessionId: p.sessionId,
          defaultConfig: deriveSessionConfig(getDefaultConfig(), p.tools),
          runtimeConfig: deriveSessionConfig(getDefaultConfig(), p.tools),
          ...(p.workspaceId !== undefined ? { workspaceId: p.workspaceId } : {}),
          ...(p.workspaceName !== undefined
            ? { workspaceName: p.workspaceName }
            : {}),
          ...(p.cwd !== undefined ? { initialCwd: p.cwd } : {}),
          ...(normalizedSelectedModel !== undefined ? { preferences: { selectedModel: normalizedSelectedModel } } : {}),
        })
        // `ensure` is the durable commit point. Acknowledge immediately so a
        // slow Session-list refresh, skill scan, or advisory lifecycle hook can
        // never turn a successful create into a client-visible timeout.
        ack?.({ ok: true })
        void (async () => {
          try {
            await refreshSessionSkillsIfNeeded(deps, record)
            await socket.join(sessionRoom(record.sessionId))
            socket.emit('session:ready', readyEventFor(record, effectiveModelForRecord(deps, record), created ? 'created' : 'load', contextWindowForSession(deps, record)))
            if (!created) return
            deps.audit?.log({ action: 'dashboard.session_create', actor: auditActor(socket), target: { sessionId: record.sessionId, workspaceId: record.workspaceId }, outcome: 'ok', metadata: { cwd: record.state.cwd } })
            await broadcastSessionList(deps)
            void Promise.resolve(deps.onSessionCreated?.(record)).catch(() => {})
          } catch (error) {
            deps.broadcastError(record.sessionId, 'host', error instanceof Error ? error.message : String(error))
          }
        })()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        deps.broadcastError(p.sessionId, 'host', message)
        ack?.({ ok: false, error: message })
      }
    })

    socket.on('client:fork', async (raw: ClientFork) => {
      const p = vparse(schema.ClientForkSchema, raw, 'client:fork', (raw as ClientFork | undefined)?.sourceSessionId)
      if (!p) return
      try {
        const source = await deps.store.load(p.sourceSessionId)
        const parsed = await readSessionLog(source.logPath)
        const keptEvents = parsed.events
          .filter((e) => e.seq <= p.cursor)
          .map((e) => e.event)
        const forkedState: AgentState = fold(
          parsed.header.initialState,
          keptEvents,
          parsed.header.config,
        )
        const newId = p.newSessionId ?? ulid()
        const record = await deps.store.create({
          sessionId: newId,
          config: source.config,
          parentSessionId: p.sourceSessionId,
          parentCursor: p.cursor,
          initialState: forkedState,
          ...(source.workspaceId !== undefined
            ? { workspaceId: source.workspaceId }
            : {}),
          ...(source.workspaceName !== undefined
            ? { workspaceName: source.workspaceName }
            : {}),
        })
        await refreshSessionSkillsIfNeeded(deps, record)
        const parentModel = effectiveModelForRecord(deps, source)
        if (parentModel) {
          await deps.store.updatePreferences(record.sessionId, { selectedModel: parentModel })
          record.preferences = { ...record.preferences, selectedModel: parentModel }
        }
        if (source.workspaceId) {
          await deps.executors.copyOverflowSession(
            source.workspaceId,
            p.sourceSessionId,
            record.sessionId,
          ).catch(() => undefined)
        }
        await socket.join(sessionRoom(record.sessionId))
        const forked: SessionReadyEvent = {
          sessionId: record.sessionId,
          reason: 'forked',
          parentSessionId: p.sourceSessionId,
          parentCursor: p.cursor,
          cursor: record.state.cursor,
          state: record.state,
          config: record.config,
          contextSnapshot: contextSnapshot(record, record.state.messages, contextWindowForSession(deps, record), parentModel),
          ...(parentModel ? { selectedModel: parentModel } : {}),
          ...(record.workspaceId !== undefined
            ? { workspaceId: record.workspaceId }
            : {}),
          ...(record.workspaceName !== undefined
            ? { workspaceName: record.workspaceName }
            : {}),
        }
        socket.emit('session:ready', forked)
        deps.audit?.log({ action: 'dashboard.session_fork', actor: auditActor(socket), target: { sessionId: record.sessionId, sourceSessionId: p.sourceSessionId }, outcome: 'ok', refs: { parentCursor: p.cursor } })
        await broadcastSessionList(deps)
        if (typeof p.seedMessage === 'string' && p.seedMessage.trim().length > 0) {
          await deps.loop.dispatch(record.sessionId, {
            kind: 'user_message',
            text: p.seedMessage,
          }, parentModel ? { model: parentModel } : undefined)
        }
      } catch (err) {
        deps.broadcastError(
          p.sourceSessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:delete_session', async (raw: ClientDeleteSession, ack?: (result: RpcAck) => void) => {
      const p = vparse(schema.ClientDeleteSessionSchema, raw, 'client:delete_session', (raw as ClientDeleteSession | undefined)?.sessionId)
      if (!p) { ack?.({ ok: false, error: 'invalid delete session request' }); return }
      const result = await operations.run(p.operationId, async () => {
        // A child Session has no independent lifecycle: deleting its root while
        // retaining descendants produces unreachable sub-agent records. Resolve
        // the complete tree first, reject the whole operation if any member is
        // active, then delete leaves before their parents.
        const targetIds = collectSessionDescendants(await deps.store.listSummaries(), p.sessionId)
        for (const targetSessionId of targetIds) {
          if (deps.loop.hasActiveTurn(targetSessionId)) throw new Error('session tree has an active turn; stop it before deleting')
        }
        for (const targetSessionId of targetIds.reverse()) {
          const record = deps.store.get(targetSessionId) ?? (await deps.store.load(targetSessionId).catch(() => undefined))
          if (record && deps.onSessionDeleted) {
            try {
              await deps.onSessionDeleted(record)
            } catch {
              // Lifecycle hook errors are advisory — swallow.
            }
          }
          if (record?.workspaceId) {
            deps.executors.closeSessionTerminals({ workspaceId: record.workspaceId, sessionId: targetSessionId })
            await deps.executors.deleteOverflowSession(record.workspaceId, targetSessionId).catch(() => undefined)
          }
          await deps.store.delete(targetSessionId)
          resetCompactRuntime(targetSessionId)
          deps.audit?.log({ action: 'dashboard.session_delete', actor: auditActor(socket), target: { sessionId: targetSessionId, workspaceId: record?.workspaceId }, outcome: 'ok', refs: { rootSessionId: p.sessionId } })
          ns.emit('server:session_deleted', { sessionId: targetSessionId })
        }
      })
      ack?.(result)
      if (!result.ok) deps.broadcastError(p.sessionId, 'host', result.error)
    })

    socket.on('client:update_preferences', async (raw) => {
      const p = vparse(schema.ClientUpdatePreferencesSchema, raw, 'client:update_preferences', (raw as { sessionId?: string } | undefined)?.sessionId)
      if (!p) return
      if ('selectedModel' in p.preferences) {
        deps.audit?.log({ action: 'dashboard.model_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { model: p.preferences.selectedModel?.trim() ?? '' } })
      }
      await applyPreferencesUpdate(deps, p.sessionId, p.preferences)
    })
  })
}

function executorSnapshotFor(deps: DashboardDeps): readonly AttachedExecutor[] {
  return deps.executorSnapshot ? deps.executorSnapshot() : deps.executors.snapshot()
}

function deriveSessionConfig(
  base: AgentConfig,
  toolAllowlist: readonly string[] | undefined,
): AgentConfig {
  if (!toolAllowlist) return base
  const allowed = new Set(toolAllowlist)
  return { ...base, tools: base.tools.filter((t) => allowed.has(t.name)) }
}

async function refreshSessionSkillsIfNeeded(
  deps: DashboardDeps,
  record: SessionRecord,
): Promise<void> {
  if (!isSkillManager(deps.loopDeps.skills)) return
  await deps.loopDeps.skills.refreshConfig(record)
}

function auditActor(socket: { data: Record<string, unknown> }): AuditActor {
  const actor = socket.data.dashboardActor as AuditActor | undefined
  return actor ?? { kind: 'anonymous' }
}

function auditConnectionMeta(meta: ConnectionMeta): Record<string, unknown> {
  return {
    connectionKind: meta.kind,
    connectionLabel: meta.label,
    clientVersion: meta.clientVersion,
  }
}

/**
 * Apply a partial preferences patch. Empty string on `selectedModel` clears
 * it (back to the host default) and emits a control-plane update.
 */
async function applyPreferencesUpdate(
  deps: DashboardDeps,
  sessionId: string,
  patch: import('@agent-kernel/shared').SessionPreferences,
): Promise<void> {
  const normalizedPatch = normalizePreferencesPatch(deps, sessionId, patch)
  if (!normalizedPatch) return
  let effective: import('@agent-kernel/shared').SessionPreferences
  try {
    effective = await deps.store.updatePreferences(sessionId, normalizedPatch)
  } catch (err) {
    deps.broadcastError(
      sessionId,
      'host',
      err instanceof Error ? err.message : String(err),
    )
    return
  }
  deps.dashboardNs.emit('server:control_update', {
    kind: 'session_meta_changed',
    sessionId,
    preferences: effective,
  })
  const record = deps.store.get(sessionId)
  if (record) {
    deps.dashboardNs.to(sessionRoom(sessionId)).emit('state:changed', {
      sessionId,
      cursor: record.state.cursor,
      state: record.state,
      contextSnapshot: contextSnapshot(record, record.state.messages, contextWindowForSession(deps, record), effectiveModelForRecord(deps, record)),
    })
  }
}

function contextWindowForSession(deps: DashboardDeps, record: SessionRecord): ContextWindowOverride | undefined {
  return deps.contextWindowForModel?.(effectiveModelForRecord(deps, record))
}

function contextWindowForModelRef(deps: DashboardDeps, model: string | undefined): ContextWindowOverride | undefined {
  return deps.contextWindowForModel?.(model)
}

function selectedModelForRecord(record: SessionRecord): string | undefined {
  return record.preferences.selectedModel
}

function effectiveModelForRecord(deps: DashboardDeps, record: SessionRecord): string | undefined {
  return deps.effectiveModelForSession?.(record) ?? selectedModelForRecord(record)
}

function effectiveDefaultModel(deps: DashboardDeps): string | undefined {
  return deps.effectiveDefaultModel?.()
}

function normalizePreferencesPatch(
  deps: DashboardDeps,
  sessionId: string,
  patch: import('@agent-kernel/shared').SessionPreferences,
): import('@agent-kernel/shared').SessionPreferences | null {
  if (!('selectedModel' in patch)) return patch
  const selectedModel = patch.selectedModel?.trim()
  if (!selectedModel) return { ...patch, selectedModel: '' }
  const normalized = normalizeIncomingModel(deps, selectedModel)
  if (!normalized) {
    deps.broadcastError(sessionId, 'host', `unknown or ambiguous model: ${selectedModel}`)
    return null
  }
  return { ...patch, selectedModel: normalized }
}

function normalizeIncomingModel(deps: DashboardDeps, model: string): string | undefined {
  return deps.normalizeModelRef ? deps.normalizeModelRef(model) : model.trim()
}

async function safeDispatch(
  deps: DashboardDeps,
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  try {
    // Sessions must be materialised via `client:create_session` (which binds
    // a workspaceId) or via `client:fork`. A user event arriving against an
    // unknown sessionId means either a stale dashboard URL or a bug — either
    // way we refuse to lazy-create, because a lazy-created session has no
    // workspaceId, cannot route tool calls, and lands in the Explorer's
    // Unassigned bucket forever. Surface the miss so the user notices.
    const record = await loadRecordForDashboard(deps, sessionId)
    if (!record) {
      deps.broadcastError(
        sessionId,
        'host',
        'session not created — click "New" in the sidebar to start a session bound to a workspace',
      )
      return
    }
    await deps.loop.dispatch(sessionId, event)
  } catch (err) {
    deps.broadcastError(
      sessionId,
      'kernel',
      err instanceof Error ? err.message : String(err),
    )
  }
}

async function handleUserMessage(
  deps: DashboardDeps,
  p: ClientUserMessage,
): Promise<void> {
  let record = deps.store.get(p.sessionId)
  if (!record) record = await loadRecordForDashboard(deps, p.sessionId)
  if (!record) {
    deps.broadcastError(
      p.sessionId,
      'host',
      'session not created — click "New" in the sidebar to start a session bound to a workspace',
    )
    return
  }
  const messageModel = effectiveModelForRecord(deps, record)
  if (record.state.status === 'thinking' && !deps.loop.hasActiveLlmCall(p.sessionId)) {
    await deps.loop.recoverInterruptedLlm(p.sessionId)
    record = await loadRecordForDashboard(deps, p.sessionId)
    if (!record) return
  }
  const requestedMode = p.mode ?? 'steer'
  // Queue is a follow-up while another accepted message or turn is active.
  // The durable ACK for the first message can arrive before its background
  // drain changes the kernel status, so status alone has a race: a second
  // queue-mode send could be misclassified as a front-priority steer and move
  // ahead of the item whose commit callback owns the dequeue fence. Include
  // both host-owned queue and Loop activity in the admission state. Only a
  // truly quiescent queue-mode send becomes a hidden immediate steer.
  const messagePipelineIdle = deps.messageQueues.pending(p.sessionId) === 0
    && !deps.loop.hasActiveTurn(p.sessionId)
  const mode = requestedMode === 'queue' && isRestingStatus(record.state.status) && messagePipelineIdle
    ? 'steer'
    : requestedMode
  const queued: QueuedUserMessage = {
    id: ulid(),
    operationId: p.operationId ?? ulid(),
    text: p.text,
    mode,
    createdAt: new Date().toISOString(),
    ...(p.content ? { content: p.content } : {}),
    ...(messageModel ? { model: messageModel } : {}),
  }
  // The Socket.IO ACK means "reliably accepted", not "the Agent turn has
  // completed". Persist every message before acknowledging, then drain in the
  // background. Awaiting loop.dispatch here made an idle direct send hold its
  // ACK for the entire LLM/tool turn; the dashboard timed out and restored a
  // draft that had already been sent.
  await deps.messageQueues.enqueue(p.sessionId, queued, mode === 'steer' ? 'front' : undefined)
  if (mode === 'steer' && !isRestingStatus(record.state.status)) {
    // Do not truncate an in-flight response/tool. Stop at the next safe boundary
    // and let the persisted front-queued steer become the next user turn.
    deps.loop.requestStopAtBoundary(p.sessionId)
  }
  void deps.messageQueues.drain(p.sessionId)
}

async function loadRecordForDashboard(
  deps: DashboardDeps,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  let record: SessionRecord | undefined = deps.store.get(sessionId)
  if (!record) {
    try {
      const defaultConfig = typeof deps.defaultConfig === 'function'
        ? deps.defaultConfig()
        : deps.defaultConfig
      record = await deps.store.load(sessionId, { runtimeConfig: defaultConfig })
    } catch {
      record = undefined
    }
  }
  return record
}

async function validateSessionCwd(
  deps: DashboardDeps,
  record: SessionRecord,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'cwd is empty' }
  const resolved = resolvePath(trimmed)
  const executor = record.workspaceId
    ? deps.executors.snapshot().find((e) => e.workspaceId === record.workspaceId)
    : deps.executors.executorForSession(record.sessionId)
  if (!executor) return { ok: false, reason: record.workspaceId ? 'workspace offline' : 'no executor connected' }
  const roots = executor?.sandboxRoots ?? []
  if (roots.length === 0) return await validateDirectoryExists(deps, executor.workspaceId, resolved)
  for (const root of roots) {
    const r = resolvePath(root)
    if (resolved === r || resolved.startsWith(r + sep)) {
      return await validateDirectoryExists(deps, executor.workspaceId, resolved)
    }
  }
  return {
    ok: false,
    reason: 'cwd outside sandbox roots',
  }
}

async function validateWorkspaceCwd(
  deps: DashboardDeps,
  workspaceId: string,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'cwd is empty' }
  const windowsPath = /^[a-z]:[\\/]/iu.test(trimmed)
  const normalizeRemotePath = (value: string): string => windowsPath
    ? value.replaceAll('/', '\\').replace(/\\+$/u, '').toLowerCase()
    : resolvePath(value)
  const resolved = windowsPath ? trimmed.replaceAll('/', '\\') : resolvePath(trimmed)
  const executor = deps.executors.snapshot().find((e) => e.workspaceId === workspaceId)
  if (!executor) return { ok: false, reason: 'workspace offline' }
  const roots = executor.sandboxRoots ?? []
  if (roots.length === 0) return await validateDirectoryExists(deps, workspaceId, resolved)
  for (const root of roots) {
    const r = windowsPath ? root.replaceAll('/', '\\') : resolvePath(root)
    const candidateKey = normalizeRemotePath(resolved)
    const rootKey = normalizeRemotePath(r)
    const separator = windowsPath ? '\\' : sep
    if (candidateKey === rootKey || candidateKey.startsWith(rootKey.endsWith(separator) ? rootKey : rootKey + separator)) {
      return await validateDirectoryExists(deps, workspaceId, resolved)
    }
  }
  return {
    ok: false,
    reason: 'cwd outside sandbox roots',
  }
}

async function validateDirectoryExists(
  deps: DashboardDeps,
  workspaceId: string,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const listed = await deps.executors.listDirs(workspaceId, cwd, ulid())
  if (listed.error) {
    return { ok: false, reason: `cwd is not a readable directory: ${listed.error}` }
  }
  return { ok: true, cwd: listed.path || cwd }
}

async function broadcastSessionList(deps: DashboardDeps): Promise<void> {
  const sessions = withQueuedCounts(deps, await deps.store.listSummaries())
  deps.dashboardNs.emit('server:sessions', { sessions })
}

/**
 * Annotate each summary with its pending queue depth so the dashboard can tell
 * a real turn end from a transient mid-turn `done` that a queued message will
 * immediately re-drive (see SessionSummary.queuedCount).
 */
function withQueuedCounts(deps: DashboardDeps, sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.map((s) => {
    const queuedCount = deps.messageQueues.pending(s.sessionId)
    return queuedCount > 0 ? { ...s, queuedCount } : s
  })
}

function collectSessionDescendants(
  sessions: readonly { sessionId: string; parentSessionId?: string }[],
  rootSessionId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentSessionId) continue
    const children = childrenByParent.get(session.parentSessionId) ?? []
    children.push(session.sessionId)
    childrenByParent.set(session.parentSessionId, children)
  }
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [rootSessionId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    queue.push(...(childrenByParent.get(id) ?? []))
  }
  return out
}

async function readJsonLogArtifact(logPath: string, refPath: string): Promise<unknown> {
  const base = dirname(logPath)
  const resolved = resolvePath(base, refPath)
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error('artifact path escapes session directory')
  }
  return JSON.parse(await readFile(resolved, 'utf8'))
}

export function readyEventFor(
  record: SessionRecord,
  selectedModel?: string,
  reason: SessionReadyEvent['reason'] = 'load',
  contextOverride?: ContextWindowOverride,
): SessionReadyEvent {
  return {
    sessionId: record.sessionId,
    reason,
    cursor: record.state.cursor,
    state: record.state,
    config: record.config,
    contextSnapshot: contextSnapshot(record, record.state.messages, contextOverride, selectedModel),
    ...(record.parentSessionId
      ? { parentSessionId: record.parentSessionId }
      : {}),
    ...(record.parentCursor !== undefined
      ? { parentCursor: record.parentCursor }
      : {}),
    ...(record.parentCallId !== undefined
      ? { parentCallId: record.parentCallId }
      : {}),
    ...(record.agentType !== undefined
      ? { agentType: record.agentType }
      : {}),
    ...(record.subAgentStartedAt !== undefined
      ? { subAgentStartedAt: record.subAgentStartedAt }
      : {}),
    ...(record.workspaceId !== undefined
      ? { workspaceId: record.workspaceId }
      : {}),
    ...(record.workspaceName !== undefined
      ? { workspaceName: record.workspaceName }
      : {}),
    ...(selectedModel ? { selectedModel } : {}),
  }
}

// Session-not-yet-on-disk fallback. Returns a plausible `session:ready`
// carrying a fresh initial state so the dashboard can render an empty chat
// and let the user compose a message. Nothing is persisted here; the JSONL
// file is written the first time `client:user_message` / `client:fork`
// forces a `store.ensure()` inside the dispatch path.
export function ephemeralReadyEventFor(
  sessionId: string,
  defaultConfig: AgentConfig,
  selectedModel?: string,
  contextOverride?: ContextWindowOverride,
): SessionReadyEvent {
  const state = createInitialState({
    sessionId,
    ...(defaultConfig.systemPrompt
      ? { systemPrompt: defaultConfig.systemPrompt }
      : {}),
  })
  return {
    sessionId,
    cursor: state.cursor,
    state,
    config: defaultConfig,
    contextSnapshot: snapshotFromConfig(defaultConfig, state.messages, contextOverride, selectedModel),
    ...(selectedModel ? { selectedModel } : {}),
  }
}

/**
 * Build a lookup from `runtime_metadata` entries so that each historical
 * `messages_replaced (compaction)` event can be re-united with the
 * `compaction_applied` record that carries its token deltas and trigger.
 *
 * Keying uses `replaceRange` because that's the only identifier both sides
 * always agree on: the kernel event carries `replaceRange`, and the
 * compaction extension writes the same `replaceRange` into the metadata
 * payload right after `dispatchOne` returns. `attemptId` isn't on the
 * kernel event, so it can't be the key.
 *
 * When multiple compactions in the same session happen to share an
 * identical `replaceRange` (rare but possible over long sessions), we keep
 * them ordered as a queue and pop the head per consumption — preserving
 * append order so replay matches live.
 *
 * Exported for tests; not intended as a public API.
 */
export function buildCompactionMetadataIndex(
  entries: readonly RuntimeMetadataEntry[],
): Map<string, CompactionMetadata[]> {
  const byRange = new Map<string, CompactionMetadata[]>()
  for (const entry of entries) {
    if (entry.action !== 'compaction_applied') continue
    const meta = extractCompactionMetadata(entry.payload)
    if (!meta) continue
    const key = compactionRangeKey(meta.__rangeStart, meta.__rangeEnd)
    const bucket = byRange.get(key) ?? []
    bucket.push(meta.value)
    byRange.set(key, bucket)
  }
  return byRange
}

export function consumeCompactionMetadata(
  index: Map<string, CompactionMetadata[]>,
  range: { start: number; end: number },
): CompactionMetadata | undefined {
  const key = compactionRangeKey(range.start, range.end)
  const bucket = index.get(key)
  if (!bucket || bucket.length === 0) return undefined
  const [head, ...rest] = bucket
  if (rest.length === 0) index.delete(key)
  else index.set(key, rest)
  return head
}

function compactionRangeKey(start: number, end: number): string {
  return `${start}:${end}`
}

function extractCompactionMetadata(
  payload: Record<string, unknown>,
): { value: CompactionMetadata; __rangeStart: number; __rangeEnd: number } | null {
  const trigger = payload.trigger
  if (trigger !== 'manual' && trigger !== 'auto' && trigger !== 'preflight' && trigger !== 'tool_result') return null
  const range = payload.replaceRange as { start?: unknown; end?: unknown } | undefined
  if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') return null
  const tokensBefore = typeof payload.tokensBefore === 'number' ? payload.tokensBefore : 0
  const tokensAfter = typeof payload.tokensAfter === 'number' ? payload.tokensAfter : 0
  const replacedCount = typeof payload.replacedCount === 'number'
    ? payload.replacedCount
    : Math.max(0, range.end - range.start)
  const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : undefined
  return {
    __rangeStart: range.start,
    __rangeEnd: range.end,
    value: {
      trigger,
      tokensBefore,
      tokensAfter,
      replacedCount,
      ...(attemptId ? { attemptId } : {}),
    },
  }
}
