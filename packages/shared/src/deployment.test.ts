import { describe, expect, it } from 'vitest'

import {
  PORTABLE_DEPLOYMENT,
  parseProductDeploymentConfig,
  productVariant,
} from './deployment.js'

describe('product deployment configuration', () => {
  it('derives the three user-facing variants from architecture and tenancy', () => {
    expect(productVariant(parseProductDeploymentConfig({ schemaVersion: 1, architecture: 'portable', runtimeProfile: 'full' }))).toBe('portable')
    expect(productVariant(parseProductDeploymentConfig({ schemaVersion: 1, architecture: 'platform', tenancy: 'single-tenant', runtimeProfile: 'full' }))).toBe('dedicated')
    expect(productVariant(parseProductDeploymentConfig({ schemaVersion: 1, architecture: 'platform', tenancy: 'multi-tenant', runtimeProfile: 'agent' }))).toBe('private-cloud')
  })

  it('rejects ambiguous or future configuration instead of guessing', () => {
    expect(() => parseProductDeploymentConfig({ schemaVersion: 1, architecture: 'platform', runtimeProfile: 'full' })).toThrow('tenancy')
    expect(() => parseProductDeploymentConfig({ schemaVersion: 2, architecture: 'portable', runtimeProfile: 'full' })).toThrow('schema version')
    expect(() => parseProductDeploymentConfig({ schemaVersion: 1, architecture: 'portable', tenancy: 'single-tenant', runtimeProfile: 'full' })).toThrow('unknown')
  })

  it('keeps direct execution Portable by default', () => {
    expect(PORTABLE_DEPLOYMENT.architecture).toBe('portable')
  })
})
