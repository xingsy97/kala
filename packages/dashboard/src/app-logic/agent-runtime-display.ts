import type { AgentRuntimeDescriptor } from '@agent-kernel/shared'
import type { TFunction } from 'i18next'

export function runtimeDisplayLabel(t: TFunction, runtime: Pick<AgentRuntimeDescriptor, 'id' | 'label'>): string {
  if (runtime.id === 'kernel') return t('dialogs.runtime.kalaKernel.label')
  if (runtime.id === 'copilot') return t('dialogs.runtime.githubCopilot.label')
  return runtime.label
}

export function runtimeDisplayDescription(t: TFunction, runtime: Pick<AgentRuntimeDescriptor, 'id' | 'description'>): string {
  if (runtime.id === 'kernel') return t('dialogs.runtime.kalaKernel.description')
  if (runtime.id === 'copilot') return t('dialogs.runtime.githubCopilot.description')
  return runtime.description
}

export function isRecommendedRuntime(runtime: Pick<AgentRuntimeDescriptor, 'id'>): boolean {
  return runtime.id === 'kernel'
}
