export const DEPLOYMENT_CONFIG_SCHEMA_VERSION = 1 as const

export type DeploymentArchitecture = 'portable' | 'platform'
export type PlatformTenancy = 'single-tenant' | 'multi-tenant'
export type ProductVariant = 'portable' | 'dedicated' | 'private-cloud'
export type RuntimeCapabilityProfile = 'full' | 'agent'

export type ProductDeploymentConfig =
  | { schemaVersion: typeof DEPLOYMENT_CONFIG_SCHEMA_VERSION; architecture: 'portable'; runtimeProfile: RuntimeCapabilityProfile }
  | { schemaVersion: typeof DEPLOYMENT_CONFIG_SCHEMA_VERSION; architecture: 'platform'; tenancy: PlatformTenancy; runtimeProfile: RuntimeCapabilityProfile }

export const PORTABLE_DEPLOYMENT: ProductDeploymentConfig = Object.freeze({
  schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
  architecture: 'portable',
  runtimeProfile: 'full',
})

export const DEDICATED_DEPLOYMENT: ProductDeploymentConfig = Object.freeze({
  schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
  architecture: 'platform',
  tenancy: 'single-tenant',
  runtimeProfile: 'full',
})

export const PRIVATE_CLOUD_DEPLOYMENT: ProductDeploymentConfig = Object.freeze({
  schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
  architecture: 'platform',
  tenancy: 'multi-tenant',
  runtimeProfile: 'agent',
})

export function parseProductDeploymentConfig(value: unknown): ProductDeploymentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('deployment config must be an object')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== DEPLOYMENT_CONFIG_SCHEMA_VERSION) throw new Error('unsupported deployment config schema version')
  if (input.runtimeProfile !== 'full' && input.runtimeProfile !== 'agent') throw new Error('deployment config requires a valid runtimeProfile')
  if (input.architecture === 'portable') {
    assertExactKeys(input, ['schemaVersion', 'architecture', 'runtimeProfile'])
    return { schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION, architecture: 'portable', runtimeProfile: input.runtimeProfile }
  }
  if (input.architecture === 'platform') {
    if (input.tenancy !== 'single-tenant' && input.tenancy !== 'multi-tenant') throw new Error('platform deployment requires a valid tenancy mode')
    assertExactKeys(input, ['schemaVersion', 'architecture', 'tenancy', 'runtimeProfile'])
    return { schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION, architecture: 'platform', tenancy: input.tenancy, runtimeProfile: input.runtimeProfile }
  }
  throw new Error('invalid deployment architecture')
}

export function productVariant(config: ProductDeploymentConfig): ProductVariant {
  if (config.architecture === 'portable') return 'portable'
  return config.tenancy === 'single-tenant' ? 'dedicated' : 'private-cloud'
}

export function effectiveTenancy(config: ProductDeploymentConfig): PlatformTenancy {
  return config.architecture === 'platform' ? config.tenancy : 'single-tenant'
}

function assertExactKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = new Set(allowed)
  const unknown = Object.keys(input).find((key) => !expected.has(key))
  if (unknown) throw new Error(`unknown deployment config field: ${unknown}`)
}
