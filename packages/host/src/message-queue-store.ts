import type { MessageContent } from '@agent-kernel/kernel'
import { schema, type RuntimeMetadataEntry } from '@agent-kernel/shared'

import type { SessionStore } from './store/session.js'
import { appendRuntimeMetadataEntry, findLatestRuntimeMetadata } from './store/log.js'
import type { QueuedUserMessage } from './connection/dashboard-ns.js'

const ACTION = 'message_queue_snapshot'
const SCHEMA_VERSION = 1

export async function loadPersistedMessageQueue(
  store: SessionStore,
  sessionId: string,
): Promise<QueuedUserMessage[]> {
  // Queue hydration runs before RestartCoordinator cursor fencing on a
  // replacement Runtime. It is an observational read of runtime metadata, not
  // crash recovery ownership: using the Store default here would synthesize a
  // failed Tool result for a valid before_tool_dispatch checkpoint and advance
  // Session JSONL before planned continuation can verify its frozen cursor.
  const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false })
  const entry = await findLatestRuntimeMetadata(record.logPath, ACTION, { maxScanBytes: 64 * 1024 * 1024 })
  return entry ? normalizeQueueSnapshot(entry) : []
}

export async function persistMessageQueueSnapshot(
  store: SessionStore,
  sessionId: string,
  items: readonly QueuedUserMessage[],
): Promise<void> {
  // Persisting host-owned queue metadata must likewise never claim recovery
  // ownership for an unloaded planned-restart participant.
  const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false })
  await appendRuntimeMetadataEntry(record.logPath, {
    sessionId,
    action: ACTION,
    payload: {
      schemaVersion: SCHEMA_VERSION,
      items: items.map(serializeQueuedMessage),
    },
  })
}

function normalizeQueueSnapshot(entry: RuntimeMetadataEntry): QueuedUserMessage[] {
  const payload = entry.payload
  if (!payload || payload.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.items)) return []
  const out: QueuedUserMessage[] = []
  for (const raw of payload.items) {
    const item = normalizeQueuedMessage(raw)
    if (item) out.push(item)
  }
  return out
}

function normalizeQueuedMessage(raw: unknown): QueuedUserMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const id = stringValue(record.id)
  const operationId = stringValue(record.operationId)
  const text = typeof record.text === 'string' ? record.text : undefined
  const createdAt = stringValue(record.createdAt)
  const mode = record.mode === 'queue' || record.mode === 'steer' ? record.mode : undefined
  const content = schema.MessageContentSchema.array().safeParse(record.content ?? [])
  if (!id || text === undefined || !createdAt || !mode || !content.success) return undefined
  if (text.trim().length === 0 && content.data.length === 0) return undefined
  return {
    id,
    operationId: operationId ?? id,
    text,
    mode,
    createdAt,
    ...(content.data.length > 0 ? { content: content.data as readonly MessageContent[] } : {}),
    ...(typeof record.model === 'string' && record.model.trim().length > 0 ? { model: record.model } : {}),
  }
}

function serializeQueuedMessage(item: QueuedUserMessage): Record<string, unknown> {
  return {
    id: item.id,
    operationId: item.operationId,
    text: item.text,
    mode: item.mode,
    createdAt: item.createdAt,
    ...(item.content ? { content: item.content } : {}),
    ...(item.model ? { model: item.model } : {}),
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
