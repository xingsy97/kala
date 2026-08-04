export type SubAgentRole = 'research' | 'test' | 'review'

export type SubAgentPolicyReasonCode =
  | 'role_template_applied'
  | 'role_unknown'
  | 'policy_max_turns_capped'
  | 'policy_timeout_capped'
  | 'policy_allowed_tools_intersected'
  | 'policy_max_depth_exceeded'
  | 'policy_max_fanout_exceeded'

export type SubAgentPolicyInput = {
  role?: SubAgentRole
  objective?: string
  allowedTools?: readonly string[]
  maxTurns?: number
  timeoutMs?: number
  expectedOutput?: string
}

export type SubAgentPolicy = {
  role?: SubAgentRole
  objective?: string
  allowedTools?: readonly string[]
  maxTurns?: number
  timeoutMs?: number
  expectedOutput?: string
  /**
   * Depth cap the host is enforcing for this sub-agent call. `resolvedDepth`
   * is the depth of the *parent* session at the time of the call (0 = root
   * session). When `resolvedDepth >= maxDepth`, the host refuses to spawn a
   * child and records `policy_max_depth_exceeded` in `reasons`.
   */
  maxDepth?: number
  resolvedDepth?: number
  /**
   * Fan-out cap for concurrent sibling sub-agents under the same parent.
   * `concurrentSiblingCount` is the number of live sub-agents already
   * running under the parent when this call is dispatched.
   */
  maxFanOut?: number
  concurrentSiblingCount?: number
  reasons: readonly SubAgentPolicyReasonCode[]
}

export type SubAgentRoleTemplate = {
  role: SubAgentRole
  purpose: string
  defaultAllowedTools: readonly string[]
  defaultMaxTurns: number
  defaultTimeoutMs: number
  defaultExpectedOutput: string
}

export const SUB_AGENT_ROLE_TEMPLATES: Readonly<Record<SubAgentRole, SubAgentRoleTemplate>> = {
  research: {
    role: 'research',
    purpose: 'Read files and return a concise report with references.',
    defaultAllowedTools: ['read', 'grep', 'glob', 'ls', 'websearch', 'webfetch', 'todowrite'],
    defaultMaxTurns: 20,
    defaultTimeoutMs: 5 * 60_000,
    defaultExpectedOutput: 'Structured summary with file:line references.',
  },
  test: {
    role: 'test',
    purpose: 'Run focused tests and report failure causes.',
    defaultAllowedTools: ['read', 'grep', 'glob', 'ls', 'bash', 'todowrite'],
    defaultMaxTurns: 25,
    defaultTimeoutMs: 10 * 60_000,
    defaultExpectedOutput: 'Failing test names, first-failure reasons, and next actions.',
  },
  review: {
    role: 'review',
    purpose: 'Inspect the final diff and report risks before answer.',
    defaultAllowedTools: ['read', 'grep', 'glob', 'ls', 'todowrite'],
    defaultMaxTurns: 15,
    defaultTimeoutMs: 3 * 60_000,
    defaultExpectedOutput: 'Ranked list of risks/regressions with file references.',
  },
}

export function getSubAgentRoleTemplate(role: SubAgentRole | undefined): SubAgentRoleTemplate | undefined {
  return role ? SUB_AGENT_ROLE_TEMPLATES[role] : undefined
}

export function isSubAgentRole(value: unknown): value is SubAgentRole {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUB_AGENT_ROLE_TEMPLATES, value)
}

export type ResolveSubAgentPolicyInput = {
  input?: SubAgentPolicyInput
  parentTools?: readonly string[]
  /**
   * Depth of the parent session (0 = root session). When paired with
   * `maxDepth`, the resolver records `policy_max_depth_exceeded` when the
   * parent is already at the depth cap.
   */
  parentDepth?: number
  maxDepth?: number
  /**
   * Number of sub-agents currently running under the parent. When paired with
   * `maxFanOut`, the resolver records `policy_max_fanout_exceeded` when the
   * parent has already reached the cap.
   */
  concurrentSiblingCount?: number
  maxFanOut?: number
}

export function resolveSubAgentPolicy({
  input,
  parentTools,
  parentDepth,
  maxDepth,
  concurrentSiblingCount,
  maxFanOut,
}: ResolveSubAgentPolicyInput): SubAgentPolicy {
  const reasons: SubAgentPolicyReasonCode[] = []
  const template = input?.role ? SUB_AGENT_ROLE_TEMPLATES[input.role] : undefined
  const requestedRole = input?.role
  if (requestedRole && !template) {
    reasons.push('role_unknown')
  }
  if (template) {
    reasons.push('role_template_applied')
  }

  const templateAllowed = template?.defaultAllowedTools
  const explicitAllowed = input?.allowedTools
  let allowedTools: readonly string[] | undefined
  if (explicitAllowed && templateAllowed) {
    const templateSet = new Set(templateAllowed)
    allowedTools = explicitAllowed.filter((tool) => templateSet.has(tool))
    if (allowedTools.length !== explicitAllowed.length) reasons.push('policy_allowed_tools_intersected')
  } else {
    allowedTools = explicitAllowed ?? templateAllowed
  }
  if (allowedTools && parentTools && parentTools.length > 0) {
    const parentSet = new Set(parentTools)
    const beforeCount = allowedTools.length
    allowedTools = allowedTools.filter((tool) => parentSet.has(tool))
    if (allowedTools.length !== beforeCount && !reasons.includes('policy_allowed_tools_intersected')) {
      reasons.push('policy_allowed_tools_intersected')
    }
  }

  const templateMaxTurns = template?.defaultMaxTurns
  let maxTurns = input?.maxTurns ?? templateMaxTurns
  if (input?.maxTurns !== undefined && templateMaxTurns !== undefined && input.maxTurns > templateMaxTurns) {
    maxTurns = templateMaxTurns
    reasons.push('policy_max_turns_capped')
  }

  const templateTimeout = template?.defaultTimeoutMs
  let timeoutMs = input?.timeoutMs ?? templateTimeout
  if (input?.timeoutMs !== undefined && templateTimeout !== undefined && input.timeoutMs > templateTimeout) {
    timeoutMs = templateTimeout
    reasons.push('policy_timeout_capped')
  }

  const expectedOutput = input?.expectedOutput ?? template?.defaultExpectedOutput

  if (
    typeof parentDepth === 'number' &&
    typeof maxDepth === 'number' &&
    Number.isFinite(parentDepth) &&
    Number.isFinite(maxDepth) &&
    parentDepth >= maxDepth
  ) {
    reasons.push('policy_max_depth_exceeded')
  }
  if (
    typeof concurrentSiblingCount === 'number' &&
    typeof maxFanOut === 'number' &&
    Number.isFinite(concurrentSiblingCount) &&
    Number.isFinite(maxFanOut) &&
    concurrentSiblingCount >= maxFanOut
  ) {
    reasons.push('policy_max_fanout_exceeded')
  }

  const policy: SubAgentPolicy = {
    ...(input?.role ? { role: input.role } : {}),
    ...(input?.objective ? { objective: input.objective } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(typeof maxDepth === 'number' && Number.isFinite(maxDepth) ? { maxDepth } : {}),
    ...(typeof parentDepth === 'number' && Number.isFinite(parentDepth) ? { resolvedDepth: parentDepth } : {}),
    ...(typeof maxFanOut === 'number' && Number.isFinite(maxFanOut) ? { maxFanOut } : {}),
    ...(typeof concurrentSiblingCount === 'number' && Number.isFinite(concurrentSiblingCount)
      ? { concurrentSiblingCount }
      : {}),
    reasons,
  }
  return policy
}
