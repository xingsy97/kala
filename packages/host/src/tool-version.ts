import type { AgentConfig } from '@agent-kernel/kernel'

export function toolLockFor(config: AgentConfig): Readonly<Record<string, { version: string; schemaHash: string | null }>> {
  return Object.fromEntries(config.tools.map((tool) => [tool.name, { version: tool.version ?? '0.0.0', schemaHash: tool.schemaHash ?? null }]))
}

export function compareToolVersions(required: string, implemented: string | undefined): 'exact' | 'compatible' | 'different' | 'unknown' {
  if (!implemented) return 'unknown'
  if (implemented === required) return 'exact'
  const requiredMajor = Number(required.split('.')[0])
  const implementedMajor = Number(implemented.split('.')[0])
  if (Number.isInteger(requiredMajor) && Number.isInteger(implementedMajor) && requiredMajor === implementedMajor) return 'compatible'
  return 'different'
}
