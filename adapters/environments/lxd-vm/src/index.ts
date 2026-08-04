import { LxdSandboxProvider } from '@agent-kernel/eval-environment-common'
import type { SandboxProviderPlugin } from '@agent-kernel/eval-sdk'

export function createLxdVmProvider(): LxdSandboxProvider {
  return new LxdSandboxProvider({ kind: 'lxd-vm', storagePool: process.env.AGENT_EVAL_LXD_STORAGE_POOL ?? 'default' })
}
const descriptor = createLxdVmProvider().descriptor
export const evaluationPlugins: readonly SandboxProviderPlugin[] = [{ kind: 'sandbox-provider', descriptor, create: createLxdVmProvider }]
