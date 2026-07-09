/**
 * @agent-kernel/host public API.
 *
 * Wraps the pure kernel with:
 *   - LLM adapters (Anthropic, extensible)
 *   - JSONL event log (persistent session store)
 *   - Socket.IO server (dashboard + executor namespaces)
 *   - Host loop (consumes effects, feeds events)
 *
 * The kernel itself remains a pure function. Everything here is IO.
 */

export { startHostServer } from './server.js'
export type { HostServer, HostServerOptions } from './server.js'

export type { LLMAdapter, LLMResponse } from './llm/adapter.js'
export { anthropicAdapter } from './llm/anthropic.js'
export type { AnthropicOptions } from './llm/anthropic.js'
export { openaiAdapter, OpenAIHTTPError } from './llm/openai.js'
export type { OpenAIOptions } from './llm/openai.js'

export { SessionStore } from './store/session.js'
export type { SessionRecord } from './store/session.js'
export { readSessionLog, appendEventEntry, writeHeader } from './store/log.js'

export { runHostLoop } from './loop.js'
export type { HostLoopDeps, LoopHandle } from './loop.js'

export { builtinTools, createBuiltinTools } from './builtin-tools.js'
export { discoverSkills, skillToolSchema, SKILL_TOOL_NAME } from './extensions/skills.js'
export type { SkillInfo, SkillRegistry } from './extensions/skills.js'

export {
  buildSweBenchGradeCommand,
  exportSessionForSweBench,
  runSweBenchGrade,
  sweBenchRunLayout,
  writeSweBenchPredictionRun,
} from './eval/swebench.js'
export type {
  ExportSessionForSweBenchInput,
  SweBenchGradeInput,
  SweBenchRunLayout,
  WriteSweBenchPredictionInput,
} from './eval/swebench.js'
