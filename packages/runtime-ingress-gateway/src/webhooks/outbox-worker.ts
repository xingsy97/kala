import { createHmac } from 'node:crypto'
import type { ControlPlaneDatabase } from '../persistence/postgres.js'

export class WebhookOutboxWorker {
  constructor(private readonly database: ControlPlaneDatabase, private readonly options: { resolveSecret(ref: unknown, organizationId: string): Promise<string>; fetchImpl?: typeof fetch; maxAttempts?: number }) {}
  async deliverBatch(limit = 50): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const events = await transaction.query<{ id: string; organization_id: string; topic: string; payload: unknown }>(`SELECT id,organization_id,topic,payload FROM outbox_events WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at<=now() ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT $1`, [limit])
      let delivered = 0
      for (const event of events.rows) {
        const endpoints = await transaction.query<{ id: string; url: string; secret_ref: unknown }>('SELECT id,url,secret_ref FROM webhook_endpoints WHERE organization_id=$1 AND enabled AND $2=ANY(topics)', [event.organization_id, event.topic])
        try {
          for (const endpoint of endpoints.rows) {
            const body = JSON.stringify({ id: event.id, topic: event.topic, organizationId: event.organization_id, payload: event.payload })
            const secret = await this.options.resolveSecret(endpoint.secret_ref, event.organization_id)
            const signature = createHmac('sha256', secret).update(body).digest('hex')
            const response = await (this.options.fetchImpl ?? fetch)(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-runlab-event-id': event.id, 'x-agent-runlab-signature': `sha256=${signature}` }, body })
            if (!response.ok) throw new Error(`webhook HTTP ${response.status}`)
          }
          await transaction.query('UPDATE outbox_events SET delivered_at=now(),locked_at=NULL WHERE id=$1', [event.id]); delivered++
        } catch (error) {
          await transaction.query(`UPDATE outbox_events SET attempt_count=attempt_count+1,last_error=$2,available_at=now()+LEAST(interval '1 hour',interval '5 seconds'*power(2,attempt_count)),dead_lettered_at=CASE WHEN attempt_count+1 >= $3 THEN now() ELSE NULL END WHERE id=$1`, [event.id, error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), this.options.maxAttempts ?? 10])
        }
      }
      return delivered
    })
  }
}
