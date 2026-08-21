import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadProductDeploymentConfig } from './deployment-config.js'

describe('deployment config loading', () => {
  it('defaults direct execution to Portable', () => {
    expect(loadProductDeploymentConfig()).toMatchObject({ architecture: 'portable', runtimeProfile: 'full' })
  })

  it('loads Dedicated and Private Cloud from one versioned config schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'deployment-config-'))
    const path = join(root, 'deployment.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, architecture: 'platform', tenancy: 'single-tenant', runtimeProfile: 'full' }))
    expect(loadProductDeploymentConfig({ configPath: path })).toMatchObject({ architecture: 'platform', tenancy: 'single-tenant' })
  })

})
