import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ExecutionReceiptStore } from './execution-receipts.js'

describe('ExecutionReceiptStore', () => {
  it('persists completed call receipts across store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-'))
    const path = join(dir, 'receipts.json')
    const first = new ExecutionReceiptStore(path)
    await first.load()
    await first.set('call-1', { callId: 'call-1', ok: true, content: 'done' })

    const restarted = new ExecutionReceiptStore(path)
    await restarted.load()
    expect(restarted.get('call-1')).toEqual({ callId: 'call-1', ok: true, content: 'done' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('call-1')
  })

  it('coalesces a burst into one durable snapshot without losing receipts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-burst-'))
    const path = join(dir, 'receipts.json')
    const store = new ExecutionReceiptStore(path)

    await Promise.all([
      store.set('call-a', { callId: 'call-a', ok: true, content: 'a' }),
      store.set('call-b', { callId: 'call-b', ok: true, content: 'b' }),
      store.set('call-c', { callId: 'call-c', ok: false, content: 'c' }),
    ])
    await store.flush()

    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(persisted).sort()).toEqual(['call-a', 'call-b', 'call-c'])
  })

  it('serializes commits that arrive while a snapshot is being persisted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ak-receipts-serial-'))
    const path = join(dir, 'receipts.json')
    const store = new ExecutionReceiptStore(path)

    const first = store.set('call-a', { callId: 'call-a', ok: true, content: 'a' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const second = store.set('call-b', { callId: 'call-b', ok: true, content: 'b' })
    await Promise.all([first, second])

    const restarted = new ExecutionReceiptStore(path)
    await restarted.load()
    expect(restarted.get('call-a')?.content).toBe('a')
    expect(restarted.get('call-b')?.content).toBe('b')
  })
})
