import { DEDICATED_DEPLOYMENT, FULL_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'

import type { HostServerOptions } from '../server.js'
import { startLoopbackHostRuntimeUnit, type LoopbackHostRuntimeUnit } from './loopback-host-unit.js'
import { parseTenantRuntimeUnitId } from './unit.js'

export const DEDICATED_RUNTIME_UNIT_ID = parseTenantRuntimeUnitId('local')

/**
 * Composes the complete Dedicated product as the fixed `local` Runtime Unit.
 * The public listener belongs to Stable Ingress; this Unit listens privately.
 */
export async function startDedicatedRuntimeUnit(
  options: Omit<HostServerOptions, 'port' | 'httpServer' | 'deployment' | 'capabilities'>,
): Promise<LoopbackHostRuntimeUnit> {
  return await startLoopbackHostRuntimeUnit(DEDICATED_RUNTIME_UNIT_ID, {
    ...options,
    deployment: DEDICATED_DEPLOYMENT,
    capabilities: FULL_RUNTIME_CAPABILITIES,
  })
}
