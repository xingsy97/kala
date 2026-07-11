import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createAuditLogger } from './audit-log.js'

describe('audit-log', () => {
  let dir = ''

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('writes structured JSONL entries by day', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ak-audit-'))
    const logger = createAuditLogger(dir)
    logger.log({
      ts: '2026-07-11T01:02:03.000Z',
      action: 'dashboard.user_message',
      actor: { kind: 'github_user', login: 'alice' },
      target: { sessionId: 's1' },
      outcome: 'ok',
      metadata: { messageBytes: 10 },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const text = await readFile(join(dir, 'audit-2026-07-11.jsonl'), 'utf8')
    expect(JSON.parse(text.trim())).toEqual({
      ts: '2026-07-11T01:02:03.000Z',
      action: 'dashboard.user_message',
      actor: { kind: 'github_user', login: 'alice' },
      target: { sessionId: 's1' },
      outcome: 'ok',
      metadata: { messageBytes: 10 },
    })
  })
})
