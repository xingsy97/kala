import type { ToolFailure } from '@agent-kernel/kernel'

export function failureForToolError(code: string): ToolFailure {
  if (code === 'ECANCELED') return { code, category: 'cancelled', outcome: 'cancelled', retryable: false, responsibility: 'user' }
  if (code === 'ETIMEDOUT') return { code, category: 'execution', outcome: 'timeout', retryable: true, responsibility: 'system', timeoutStage: 'execution' }
  if (['EINVAL','ENOENT','EISDIR','EAMBIG','EPATCHPARSE'].includes(code)) return { code, category: 'input', outcome: 'failed', retryable: false, responsibility: 'model' }
  if (['EACCES','ESTALE','EEXIST'].includes(code)) return { code, category: 'precondition', outcome: 'blocked', retryable: true, responsibility: 'workspace' }
  if (['ENETWORK','EHTTP','ESEARCH_UNAVAILABLE'].includes(code)) return { code, category: 'infrastructure', outcome: 'failed', retryable: true, responsibility: 'provider' }
  return { code, category: 'execution', outcome: 'failed', retryable: false, responsibility: 'system' }
}
