export type NetworkPolicyRule = { ruleId: string; action: 'allow' | 'deny' | 'ask'; toolNames?: readonly string[]; executionLocations?: readonly ('host' | 'executor')[]; schemes?: readonly ('http' | 'https')[]; hostPatterns?: readonly string[]; ports?: readonly number[] }
export type NetworkPolicy = { version: 1; policyId: string; revision: string; defaultAction: 'allow' | 'deny' | 'ask'; rules: readonly NetworkPolicyRule[] }
export type NetworkTarget = { scheme: 'http' | 'https'; hostname: string; port: number }
export type NetworkAuditEvent = { schemaVersion: 1; eventId: string; ts: string; event: 'network.policy_decision' | 'network.request_observed' | 'network.coverage_notice'; sessionId: string; callId: string; toolName: string; executionLocation: 'host' | 'executor'; decisionId?: string; policyId?: string; policyRevision?: string; action?: 'allow' | 'deny' | 'ask'; matchedRuleId?: string; target?: NetworkTarget; phase?: 'started' | 'redirect' | 'response' | 'failed'; statusCode?: number; errorCode?: string; evidenceLevel: 'declared' | 'application_observed' | 'unobserved'; enforcementMode: 'application' | 'none' }

export function normalizeNetworkTarget(raw: string): NetworkTarget {
  const url = new URL(raw)
  if (url.username || url.password) throw new Error('network target must not contain credentials')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('network target must use http or https')
  return { scheme: url.protocol === 'https:' ? 'https' : 'http', hostname: url.hostname.toLocaleLowerCase().replace(/\.$/u, ''), port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 }
}

export function decideNetworkPolicy(policy: NetworkPolicy, input: { toolName: string; executionLocation: 'host' | 'executor'; url: string }): { action: 'allow' | 'deny' | 'ask'; matchedRuleId?: string; target: NetworkTarget } {
  const target = normalizeNetworkTarget(input.url)
  for (const rule of policy.rules) {
    if (rule.toolNames && !rule.toolNames.includes(input.toolName)) continue
    if (rule.executionLocations && !rule.executionLocations.includes(input.executionLocation)) continue
    if (rule.schemes && !rule.schemes.includes(target.scheme)) continue
    if (rule.ports && !rule.ports.includes(target.port)) continue
    if (rule.hostPatterns && !rule.hostPatterns.some((pattern) => hostMatches(target.hostname, pattern))) continue
    return { action: rule.action, matchedRuleId: rule.ruleId, target }
  }
  return { action: policy.defaultAction, target }
}

function hostMatches(hostname: string, pattern: string): boolean {
  const normalized = pattern.toLocaleLowerCase().replace(/\.$/u, '')
  if (normalized.startsWith('*.')) { const suffix = normalized.slice(2); return hostname !== suffix && hostname.endsWith(`.${suffix}`) }
  return hostname === normalized
}
