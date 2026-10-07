import { createHash } from 'node:crypto'

import type { MessageContent } from '@agent-kernel/kernel'

/** Stable, non-plaintext identity for a user message retried under the same operation ID. */
export function messageOperationFingerprint(text: string, content?: readonly MessageContent[]): string {
  return createHash('sha256').update(JSON.stringify([text, content ?? []])).digest('hex')
}
