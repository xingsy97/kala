import { describe, expect, it, vi } from 'vitest'

import { OperationDeduper } from './operation-deduper.js'

describe('OperationDeduper', () => {
  it('executes a duplicate operation id once and replays the ACK', async () => {
    const deduper = new OperationDeduper()
    const operation = vi.fn(async () => 'applied')

    const first = await deduper.run('op-1', operation)
    const duplicate = await deduper.run('op-1', operation)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ ok: true, value: 'applied' })
    expect(duplicate).toEqual(first)
  })

  it('coalesces concurrent duplicates', async () => {
    const deduper = new OperationDeduper()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const operation = vi.fn(async () => { await gate })

    const first = deduper.run('op-2', operation)
    const duplicate = deduper.run('op-2', operation)
    release()

    expect(await first).toEqual({ ok: true })
    expect(await duplicate).toEqual({ ok: true })
    expect(operation).toHaveBeenCalledTimes(1)
  })
})
