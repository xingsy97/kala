import type { MessageContent } from '@agent-kernel/kernel'
import type { RuntimeMetadataEntry } from '@agent-kernel/shared'

import type { SessionStore } from './store/session.js'
import { appendRuntimeMetadataEntry, readSessionLog } from './store/log.js'
import type { QueuedUserMessage } from './connection/dashboard-ns.js'

const ACTION = 'message_queue_snapshot'
const SCHEMA_VERSION = 1

export async function loadPersistedMessageQueue(
  store: SessionStore,
  sessionId: string,
): Promise<QueuedUserMessage[]> {
  const record = store.get(sessionId) ?? await store.load(sessionId)
  const parsed = await readSessionLog(record.logPath)
  for (let i = parsed.runtimeMetadata.length - 1; i >= 0; i--) {
    const entry = parsed.runtimeMetadata[i]
    if (!entry || entry.action !== ACTION) continue
    return normalizeQueueSnapshot(entry)
  }
  return []
}

export async function persistMessageQueueSnapshot(
  store: SessionStore,
  sessionId: string,
  items: readonly QueuedUserMessage[],
): Promise<void> {
  const record = store.get(sessionId) ?? await store.load(sessionId)
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
  const text = stringValue(record.text)
  const createdAt = stringValue(record.createdAt)
  const mode = record.mode === 'queue' || record.mode === 'steer' ? record.mode : undefined
  if (!id || !text || !createdAt || !mode) return undefined
  return {
    id,
    operationId: operationId ?? id,
    text,
    mode,
    createdAt,
    ...(Array.isArray(record.content) ? { content: record.content as readonly MessageContent[] } : {}),
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
