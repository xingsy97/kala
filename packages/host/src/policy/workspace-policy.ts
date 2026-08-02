export type WorkspaceToolPolicy = {
  allowedTools?: readonly string[]
  deniedTools?: readonly string[]
  maxTimeoutSeconds?: number
  maxOutputBytes?: number
  network?: 'deny' | 'allow'
  approvalMode?: 'auto' | 'confirm_all' | 'deny_unsafe'
}

export function evaluateWorkspaceToolPolicy(policy: WorkspaceToolPolicy, input: { tool: string; timeoutSeconds?: number; outputBytes?: number; needsNetwork?: boolean }): { allowed: true } | { allowed: false; reason: string } {
  if (policy.deniedTools?.includes(input.tool)) return { allowed: false, reason: 'tool denied by workspace policy' }
  if (policy.allowedTools && !policy.allowedTools.includes(input.tool)) return { allowed: false, reason: 'tool not allowed by workspace policy' }
  if (input.timeoutSeconds !== undefined && policy.maxTimeoutSeconds !== undefined && input.timeoutSeconds > policy.maxTimeoutSeconds) return { allowed: false, reason: 'timeout exceeds workspace policy' }
  if (input.outputBytes !== undefined && policy.maxOutputBytes !== undefined && input.outputBytes > policy.maxOutputBytes) return { allowed: false, reason: 'output exceeds workspace policy' }
  if (input.needsNetwork && policy.network !== 'allow') return { allowed: false, reason: 'network denied by workspace policy' }
  return { allowed: true }
}
