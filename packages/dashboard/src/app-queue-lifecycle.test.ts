import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('queued-message lifecycle delivery', () => {
  it('does not re-enqueue optimistic or deleted messages on visibilitychange or pagehide', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app.tsx'), 'utf8')

    expect(source).not.toContain('navigator.sendBeacon')
    expect(source).not.toContain("action: 'enqueue-user-message'")
    expect(source).not.toContain('pendingBeaconRef')
  })
})
