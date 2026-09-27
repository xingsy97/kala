import { open } from 'node:fs/promises'

import type { MessageContent } from '@agent-kernel/kernel'
import { schema, type RuntimeMetadataEntry } from '@agent-kernel/shared'

import type { SessionStore } from './store/session.js'
import { appendRuntimeMetadataEntry, findLatestRuntimeMetadata } from './store/log.js'
import type { QueuedUserMessage } from './connection/dashboard-ns.js'

const ACTION = 'message_queue_snapshot'
const SCHEMA_VERSION = 2
export const MAX_CANCELLED_OPERATION_IDS = 10_000

export type PersistedMessageQueueState = {
  items: QueuedUserMessage[]
  cancelledOperationIds: string[]
}

export async function loadPersistedMessageQueue(
  store: SessionStore,
  sessionId: string,
): Promise<QueuedUserMessage[]> {
  return (await loadPersistedMessageQueueState(store, sessionId)).items
}

export async function loadPersistedMessageQueueState(
  store: SessionStore,
  sessionId: string,
): Promise<PersistedMessageQueueState> {
  // Queue hydration runs before RestartCoordinator cursor fencing on a
  // replacement Runtime. It is an observational read of runtime metadata, not
  // crash recovery ownership: using the Store default here would synthesize a
  // failed Tool result for a valid before_tool_dispatch checkpoint and advance
  // Session JSONL before planned continuation can verify its frozen cursor.
  const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false })
  const entry = await findLatestRuntimeMetadata(record.logPath, ACTION, { maxScanBytes: 64 * 1024 * 1024 })
  return entry ? normalizeQueueSnapshot(entry) : { items: [], cancelledOperationIds: [] }
}

export async function persistMessageQueueSnapshot(
  store: SessionStore,
  sessionId: string,
  items: readonly QueuedUserMessage[],
  cancelledOperationIds: readonly string[] = [],
): Promise<void> {
  const uniqueCancelledOperationIds = [...new Set(cancelledOperationIds)]
  if (uniqueCancelledOperationIds.length > MAX_CANCELLED_OPERATION_IDS) {
    throw new Error(`message queue cancellation tombstone limit of ${MAX_CANCELLED_OPERATION_IDS} exceeded; existing cancellations were preserved`)
  }
  // Persisting host-owned queue metadata must likewise never claim recovery
  // ownership for an unloaded planned-restart participant.
  const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false })
  await appendRuntimeMetadataEntry(record.logPath, {
    sessionId,
    action: ACTION,
    payload: {
      schemaVersion: SCHEMA_VERSION,
      items: items.map(serializeQueuedMessage),
      cancelledOperationIds: uniqueCancelledOperationIds,
    },
  })
  // Queue acceptance and cancellation are externally acknowledged durability
  // boundaries. appendFile alone may still be resident in the page cache, so
  // flush the Session JSONL before returning to ingress or the dashboard.
  const handle = await open(record.logPath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function normalizeQueueSnapshot(entry: RuntimeMetadataEntry): PersistedMessageQueueState {
  const payload = entry.payload
  if (!payload || (payload.schemaVersion !== 1 && payload.schemaVersion !== SCHEMA_VERSION) || !Array.isArray(payload.items)) {
    throw new Error('unsupported persisted message queue snapshot')
  }
  const out: QueuedUserMessage[] = []
  for (const raw of payload.items) {
    const item = normalizeQueuedMessage(raw)
    if (item) out.push(item)
  }
  const cancelledOperationIds = payload.schemaVersion === SCHEMA_VERSION
    ? normalizeCancelledOperationIds(payload.cancelledOperationIds)
    : []
  const cancelled = new Set(cancelledOperationIds)
  return { items: out.filter((item) => !cancelled.has(item.operationId)), cancelledOperationIds }
}

function normalizeCancelledOperationIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error('invalid persisted message queue cancellation tombstones: expected an array')
  }
  // Check the raw list before allocating a Set or normalizing entries. Malformed
  // snapshots must never use duplicates or invalid values to bypass the bound.
  if (raw.length > MAX_CANCELLED_OPERATION_IDS) {
    throw new Error(`persisted message queue cancellation tombstone limit of ${MAX_CANCELLED_OPERATION_IDS} exceeded`)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    const operationId = stringValue(value)
    if (!operationId) {
      throw new Error('invalid persisted message queue cancellation tombstones: expected non-empty strings')
    }
    if (seen.has(operationId)) {
      throw new Error(`invalid persisted message queue cancellation tombstones: duplicate operation ID ${JSON.stringify(operationId)}`)
    }
    seen.add(operationId)
    out.push(operationId)
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
