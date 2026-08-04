import { describe, expect, it } from 'vitest'

import { createLxdVmProvider, evaluationPlugins } from './index.js'

describe('LXD VM provider plugin', () => {
  it('advertises the canonical provider identity and protocol', () => {
    const provider = createLxdVmProvider()
    expect(provider.descriptor).toEqual({ schemaVersion: 1, providerId: 'lxd-vm', kind: 'lxd-vm', version: '0.0.0', protocolVersions: [1], capabilities: ['preflight', 'create', 'execute', 'snapshot', 'collect', 'destroy', 'verify-destroyed', 'reap-orphans'] })
    expect(evaluationPlugins).toHaveLength(1)
    expect(evaluationPlugins[0]!.create().descriptor).toEqual(provider.descriptor)
  })
})
