import { evaluateWorkspaceToolPolicy, type WorkspaceToolPolicy } from './workspace-policy.js'

export type PolicyDecisionInput = { organizationId: string; workspaceId: string; tool: string; timeoutSeconds?: number; outputBytes?: number; needsNetwork?: boolean }
export interface PolicyDecisionPoint { decide(input: PolicyDecisionInput): Promise<{ allowed: boolean; reason?: string }> }

/** Fixed typed policy remains authoritative; an external PDP is deliberately optional. */
export class FixedWorkspacePolicyDecisionPoint implements PolicyDecisionPoint {
  constructor(private readonly resolve: (workspaceId: string) => Promise<WorkspaceToolPolicy>) {}
  async decide(input: PolicyDecisionInput): Promise<{ allowed: boolean; reason?: string }> {
    return evaluateWorkspaceToolPolicy(await this.resolve(input.workspaceId), input)
  }
}
