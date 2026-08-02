export type EnterpriseModelPolicy = {
  allowedModels: readonly string[]
  defaultModel: string
  lockedModel?: string
  maxConcurrentCalls: number
  monthlyTokenLimit?: number
  fallbackModels?: readonly string[]
}

export function resolveEnterpriseModel(policy: EnterpriseModelPolicy, requested: string | undefined, usageTokens: number): { model: string; fallbacks: readonly string[] } {
  if (policy.monthlyTokenLimit !== undefined && usageTokens >= policy.monthlyTokenLimit) throw new Error('organization token quota exceeded')
  const model = policy.lockedModel ?? requested ?? policy.defaultModel
  if (!policy.allowedModels.includes(model)) throw new Error('model denied by organization policy')
  const fallbacks = (policy.fallbackModels ?? []).filter((candidate) => candidate !== model && policy.allowedModels.includes(candidate))
  return { model, fallbacks }
}

export class OrganizationConcurrencyGate {
  private readonly active = new Map<string, number>()
  async run<T>(organizationId: string, limit: number, operation: () => Promise<T>): Promise<T> {
    const count = this.active.get(organizationId) ?? 0
    if (count >= limit) throw new Error('organization LLM concurrency exceeded')
    this.active.set(organizationId, count + 1)
    try { return await operation() } finally { const next = (this.active.get(organizationId) ?? 1) - 1; if (next <= 0) this.active.delete(organizationId); else this.active.set(organizationId, next) }
  }
}
