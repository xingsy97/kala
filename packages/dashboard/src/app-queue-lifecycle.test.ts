import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('queued-message lifecycle delivery', () => {
  it('keeps accepted shell operations visible until durable Host projection replaces them', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app.tsx'), 'utf8')
    const admissionStart = source.indexOf('await admitUserMessage({', source.indexOf('onSubmit={async'))
    const admissionEnd = source.indexOf('} catch (error)', admissionStart)
    const acknowledged = source.slice(admissionStart, admissionEnd)

    expect(acknowledged).not.toContain('filter((item) => item.id !== operationId)')
    expect(source).toContain('id: operationId, text, mode, createdAt')
    expect(source).toContain('id: operationId,')
  })

  it('does not re-enqueue optimistic or deleted messages on visibilitychange or pagehide', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app.tsx'), 'utf8')

    expect(source).not.toContain('navigator.sendBeacon')
    expect(source).not.toContain("action: 'enqueue-user-message'")
    expect(source).not.toContain('pendingBeaconRef')
  })
})
