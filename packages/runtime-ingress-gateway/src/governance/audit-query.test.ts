import { describe, expect, it } from 'vitest'
import { PostgresAuditQueryService } from './audit-query.js'

describe('audit query export', () => {
  it('quotes CSV fields and excludes metadata bodies from the export', () => {
    const service = new PostgresAuditQueryService({ query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) })
    const csv = service.toCsv([{ id: 'a,"b', action: 'session.read', metadata: { secret: 'never' } }])
    expect(csv).toContain('"a,""b"')
    expect(csv).not.toContain('never')
  })
})
