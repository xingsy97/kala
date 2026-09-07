import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { WebhookOutboxWorker } from './outbox-worker.js'
import type { ControlPlaneDatabase, SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

describe('WebhookOutboxWorker', () => {
  it('delivers only organization-matched endpoints with redacted payloads and scoped signatures', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }))
    const database = new FakeWebhookDatabase()
    const worker = new WebhookOutboxWorker(database, {
      fetchImpl,
      resolveSecret: async (ref, organizationId) => {
        expect(ref).toEqual({ ref: 'tenant-secret' })
        expect(organizationId).toBe('org_acme')
        return 'webhook-secret'
      },
    })

    await expect(worker.deliverBatch(10)).resolves.toBe(1)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://hooks.example/runlab')
    const body = String(init?.body)
    const delivered = JSON.parse(body) as { organizationId: string; payload: { token: string; bundleUrl: string; message: string } }
    expect(delivered).toEqual({
      id: 'evt_1',
      topic: 'organization.provisioned',
      organizationId: 'org_acme',
      payload: {
        token: '[redacted]',
        bundleUrl: '<https://redacted>/bundle.zip?<query-redacted>',
        message: 'failed with ******',
      },
    })
    expect(body).not.toContain('raw-token')
    expect(body).not.toContain('X-Amz-Signature=secret')
    expect(init?.headers).toMatchObject({
      'x-agent-runlab-event-id': 'evt_1',
      'x-agent-runlab-signature': `sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`,
    })
    expect(database.executed.find((entry) => entry.sql.startsWith('SELECT id,url,secret_ref'))?.values).toEqual(['org_acme', 'organization.provisioned'])
    expect(database.executed.some((entry) => entry.sql.startsWith('UPDATE outbox_events SET delivered_at'))).toBe(true)
  })
})

class FakeWebhookDatabase implements ControlPlaneDatabase, SqlExecutor {
  readonly executed: Array<{ sql: string; values: readonly unknown[] }> = []

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    this.executed.push({ sql, values })
    if (sql.startsWith('SELECT id,organization_id,topic,payload FROM outbox_events')) {
      return result([{
        id: 'evt_1',
        organization_id: 'org_acme',
        topic: 'organization.provisioned',
        payload: {
          token: 'raw-token',
          bundleUrl: 'https://storage.example/bundle.zip?X-Amz-Signature=secret',
          message: 'failed with Bearer user-secret',
        },
      } as unknown as Row])
    }
    if (sql.startsWith('SELECT id,url,secret_ref FROM webhook_endpoints')) {
      return result([{ id: 'wh_1', url: 'https://hooks.example/runlab', secret_ref: { ref: 'tenant-secret' } } as unknown as Row])
    }
    if (sql.startsWith('UPDATE outbox_events SET attempt_count')) throw new Error(`unexpected delivery failure: ${String(values[1])}`)
    return result([])
  }

  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return operation(this)
  }

  async health() { return { ok: true as const, schemaVersion: 1 } }
  async close() {}
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}
