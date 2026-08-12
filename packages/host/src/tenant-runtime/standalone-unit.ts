import { FULL_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'

import type { HostServerOptions } from '../server.js'
import { startLoopbackHostRuntimeUnit, type LoopbackHostRuntimeUnit } from './loopback-host-unit.js'
import { parseTenantRuntimeUnitId } from './unit.js'

export const STANDALONE_RUNTIME_UNIT_ID = parseTenantRuntimeUnitId('local')

/**
 * Composes the complete Standalone product as the fixed `local` Runtime Unit.
 * The public listener belongs to Stable Ingress; this Unit listens privately.
 */
export async function startStandaloneRuntimeUnit(
  options: Omit<HostServerOptions, 'port' | 'httpServer' | 'deploymentMode' | 'capabilities'>,
): Promise<LoopbackHostRuntimeUnit> {
  return await startLoopbackHostRuntimeUnit(STANDALONE_RUNTIME_UNIT_ID, {
    ...options,
    deploymentMode: 'standalone',
    capabilities: FULL_RUNTIME_CAPABILITIES,
  })
}
