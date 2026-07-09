import { describe, expect, it } from 'vitest'

import { socketConnectionAuditSnapshot } from './socket-audit.js'

describe('socketConnectionAuditSnapshot', () => {
  it('counts dashboard, executor, and unknown sockets by namespace', () => {
    const io = {
      _nsps: new Map([
        ['/dashboard', namespace([{ kind: 'dashboard' }, { kind: 'dashboard' }])],
        ['/executor', namespace([{ kind: 'executor' }, {}])],
      ]),
    }

    expect(socketConnectionAuditSnapshot(io as never, () => new Date('2026-07-22T00:00:00.000Z'))).toEqual({
      total: 4,
      dashboard: 2,
      executor: 1,
      other: 1,
      namespaces: [
        { namespace: '/dashboard', sockets: 2, dashboard: 2, executor: 0, other: 0 },
        { namespace: '/executor', sockets: 2, dashboard: 0, executor: 1, other: 1 },
      ],
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
  })
})

function namespace(metas: readonly Record<string, unknown>[]): { sockets: Map<string, unknown> } {
  return {
    sockets: new Map(metas.map((meta, index) => [`socket-${index}`, { data: { connectionMeta: meta } }])),
  }
}
