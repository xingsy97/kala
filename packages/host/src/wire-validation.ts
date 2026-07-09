/**
 * Wire-boundary validation helpers.
 *
 * These are the *only* place `.parse()` should live in production code —
 * every socket handler and HTTP route funnels its untrusted payload through
 * `parseWire()` before touching business logic.
 *
 * Failures are logged with a stable structured shape and dropped. The
 * transport (socket.io / express) stays healthy; only the offending event
 * is discarded. This is the "protocol drift" surface — if it fires in
 * production, the peer is speaking a shape the server doesn't understand.
 */

import type { ZodType } from 'zod'

export type WireValidationContext = {
  /** Socket namespace + event name, or HTTP method + path. */
  channel: string
  /** Free-form identifier for the peer — socket id, remote ip, executor id. */
  peer?: string
  /** Session/workspace id if available at the boundary. */
  sessionId?: string
}

export type WireValidationLogger = (entry: {
  channel: string
  peer?: string
  sessionId?: string
  reason: string
  issues: unknown
}) => void

let logger: WireValidationLogger = (entry) => {
  try {
    // eslint-disable-next-line no-console
    console.warn('[wire_validation_failed]', JSON.stringify(entry))
  } catch {
    /* swallow */
  }
}

export function setWireValidationLogger(next: WireValidationLogger): void {
  logger = next
}

/**
 * Validate an untrusted payload against a Zod schema.
 *
 * Returns the parsed value on success. On failure, logs the issues via the
 * configured logger and returns `undefined` — callers must check and skip
 * the handler body on undefined. This deliberately does NOT throw: raising
 * inside a socket.io handler kills the socket, which is a much worse outcome
 * than dropping a single malformed event.
 */
export function parseWire<T>(
  schema: ZodType<T>,
  payload: unknown,
  ctx: WireValidationContext,
): T | undefined {
  const result = schema.safeParse(payload)
  if (result.success) return result.data
  logger({
    channel: ctx.channel,
    peer: ctx.peer,
    sessionId: ctx.sessionId,
    reason: 'schema_mismatch',
    issues: result.error.issues,
  })
  return undefined
}
