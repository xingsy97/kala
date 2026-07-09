import type { SocketConnectionAuditSnapshot } from '@agent-kernel/shared'
import type { Server as IOServer } from 'socket.io'

import type { ConnectionMeta } from './socket-metadata.js'

export function socketConnectionAuditSnapshot(io: IOServer, now: () => Date = () => new Date()): SocketConnectionAuditSnapshot {
  const namespaces: Array<SocketConnectionAuditSnapshot['namespaces'][number]> = []
  let total = 0
  let dashboard = 0
  let executor = 0
  let other = 0

  for (const [namespace, ns] of io._nsps) {
    const counts = { sockets: 0, dashboard: 0, executor: 0, other: 0 }
    for (const socket of ns.sockets.values()) {
      counts.sockets += 1
      const kind = connectionKind(socket.data?.connectionMeta)
      if (kind === 'dashboard') counts.dashboard += 1
      else if (kind === 'executor') counts.executor += 1
      else counts.other += 1
    }
    total += counts.sockets
    dashboard += counts.dashboard
    executor += counts.executor
    other += counts.other
    namespaces.push({ namespace, ...counts })
  }

  namespaces.sort((a, b) => a.namespace.localeCompare(b.namespace))
  return { total, dashboard, executor, other, namespaces, updatedAt: now().toISOString() }
}

function connectionKind(value: unknown): ConnectionMeta['kind'] | null {
  if (!value || typeof value !== 'object') return null
  const kind = (value as { kind?: unknown }).kind
  return kind === 'dashboard' || kind === 'executor' ? kind : null
}
