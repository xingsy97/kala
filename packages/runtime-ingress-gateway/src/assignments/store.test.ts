import { describe, expect, it } from 'vitest'

import { MemoryRuntimeAssignmentStore } from './store.js'

describe('MemoryRuntimeAssignmentStore', () => {
  it('creates stable opaque one-user/one-Unit assignments', async () => {
    const directory = new MemoryRuntimeAssignmentStore()
    const identity = { issuer: 'https://id.test', subject: 'user@example.com' }
    const first = await directory.getOrCreateForIdentity(identity)
    const second = await directory.getOrCreateForIdentity(identity)
    expect(first).toEqual(second)
    expect(first.unitId).not.toContain(identity.subject)
    expect(await directory.findByIdentity(identity)).toEqual(first)
  })

  it('keeps same subject from different issuers separate', async () => {
    const directory = new MemoryRuntimeAssignmentStore()
    const a = await directory.getOrCreateForIdentity({ issuer: 'https://a.example', subject: 'same' })
    const b = await directory.getOrCreateForIdentity({ issuer: 'https://b.example', subject: 'same' })
    expect(a.unitId).not.toBe(b.unitId)
  })
})
