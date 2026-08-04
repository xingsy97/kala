import { describe, expect, it } from 'vitest'

import { createLxdContainerProvider, evaluationPlugins } from './index.js'

describe('LXD system-container provider plugin', () => {
  it('advertises the canonical provider identity and protocol', () => {
    const provider = createLxdContainerProvider()
    expect(provider.descriptor).toEqual({ schemaVersion: 1, providerId: 'lxd-container', kind: 'lxd-container', version: '0.0.0', protocolVersions: [1], capabilities: ['preflight', 'create', 'execute', 'snapshot', 'collect', 'destroy', 'verify-destroyed', 'reap-orphans'] })
    expect(evaluationPlugins).toHaveLength(1)
    expect(evaluationPlugins[0]!.create().descriptor).toEqual(provider.descriptor)
  })
})
