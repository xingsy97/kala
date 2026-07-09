import type { AgentConfig, AgentModuleMetadata, ToolSchema } from '@agent-kernel/kernel'
import type { SkillInfo } from '../extensions/skills.js'

export type SystemPromptPlugin = {
  id: string
  version: string
  label: string
  render(ctx: AgentModuleContext): string
}

export type ToolRisk = 'read' | 'write' | 'shell' | 'network' | 'memory' | 'agent'
export type ToolExecutionKind = 'host' | 'executor'

export type ToolPrompt = {
  purpose: string
  whenToUse: readonly string[]
  constraints: readonly string[]
  failureHandling?: readonly string[]
}

export type ToolDefinition = {
  name: string
  inputSchema: Record<string, unknown>
  requiresApproval: boolean
  prompt: ToolPrompt
  policy: {
    risk: ToolRisk
    approvalDefault: 'auto' | 'ask' | 'deny'
  }
  execution: {
    kind: ToolExecutionKind
    handler?: string
    route?: string
    timeoutMs?: number
  }
}

export type ToolsetPlugin = {
  id: string
  version: string
  label: string
  provideTools(ctx: ToolsetContext): readonly ToolDefinition[]
}

export type RuntimePolicyPlugin = {
  id: string
  version: string
  label: string
}

export type AgentModule = {
  id: string
  version: string
  label: string
  systemPrompt: SystemPromptPlugin
  toolsets: readonly ToolsetPlugin[]
  policy?: RuntimePolicyPlugin
}

export type AgentModuleContext = {
  mode: 'coding'
  skills: readonly SkillInfo[]
  contextLimit?: number
}

export type ToolsetContext = AgentModuleContext

export type ResolvedAgentModule = {
  module: AgentModule
  systemPrompt: string
  tools: readonly ToolSchema[]
  toolDefinitions: readonly (ToolDefinition & { toolsetId: string; toolsetVersion: string; toolsetLabel: string })[]
  metadata: AgentModuleMetadata
  config: AgentConfig
}
