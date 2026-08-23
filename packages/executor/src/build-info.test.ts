import { describe, expect, it } from 'vitest'

import { semanticReleaseVersion } from './build-info.js'

describe('Executor release identity', () => {
  it('uses a semantic release tag as the update version', () => {
    expect(semanticReleaseVersion('v1.2.3-rc.1', '0.2.0-rc.1')).toBe('1.2.3-rc.1')
  })

  it('keeps channel tags separate from the product version', () => {
    expect(semanticReleaseVersion('latest', '0.2.0-rc.1')).toBe('0.2.0-rc.1')
  })

  it('fails closed when neither identity is semantic', () => {
    expect(() => semanticReleaseVersion('latest', 'development')).toThrow('not semantic')
  })
})
