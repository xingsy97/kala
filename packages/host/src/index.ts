/**
 * @agent-kernel/host public API.
 *
 * Stable exports only. SaaS tenant-runtime registries, proxies, persistence,
 * and loopback composition remain internal until their contracts mature.
 */

export { startHostServer } from './server.js'
export type { HostServer, HostServerOptions } from './server.js'
export type { TenantRuntimeUnit, TenantRuntimeUnitId, TenantRuntimeUnitState } from './tenant-runtime/unit.js'

export type { LLMAdapter, LLMResponse } from './llm/adapter.js'
export { anthropicAdapter } from './llm/anthropic.js'
export type { AnthropicOptions } from './llm/anthropic.js'
export { openaiAdapter, OpenAIHTTPError } from './llm/openai.js'
export type { OpenAIOptions } from './llm/openai.js'
export { policyGatewayAdapter } from './llm/policy-gateway.js'
export type { PolicyGatewayOptions } from './llm/policy-gateway.js'

export { SessionStore } from './store/session.js'
export type { SessionRecord } from './store/session.js'
export { readSessionLog, appendEventEntry, writeHeader } from './store/log.js'

export { runHostLoop } from './loop.js'
export type { HostLoopDeps, LoopHandle } from './loop.js'

export { builtinTools, createBuiltinTools, createBuiltinAgentModule, resolveBuiltinAgentModule } from './builtin-tools.js'
export { resolveAgentModule, renderToolDescription, renderToolSchema, stableHash } from './agent-modules/renderers.js'
export type {
  AgentModule, AgentModuleContext, ResolvedAgentModule, RuntimePolicyPlugin,
  SystemPromptPlugin, ToolDefinition, ToolExecutionKind, ToolPrompt, ToolRisk,
  ToolsetContext, ToolsetPlugin,
} from './agent-modules/types.js'
export { discoverSkills, skillToolSchema, SKILL_TOOL_NAME } from './extensions/skills.js'
export type { SkillInfo, SkillRegistry } from './extensions/skills.js'

export {
  buildSweBenchGradeCommand, exportSessionForSweBench, runSweBenchGrade,
  sweBenchRunLayout, writeSweBenchPredictionRun,
} from './eval/swebench/swebench.js'
export type {
  ExportSessionForSweBenchInput, SweBenchGradeInput, SweBenchRunLayout,
  WriteSweBenchPredictionInput,
} from './eval/swebench/swebench.js'
