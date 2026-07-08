/**
 * @agent-kernel/substrate  -  a self-improvement platform layer.
 *
 * Lets a meta-agent run a real auto-evolve loop over a coding agent's *harness*
 * (system prompt, tool set, extension knobs), judged by an out-of-loop
 * evaluator, without touching the kernel or the host core. Everything here sits
 * above `@agent-kernel/host`'s public API. See ADR 0015.
 */

export {
  applyMutation,
  applyMutations,
  describeMutation,
} from './harness.js'
export type {
  Harness,
  HarnessExtensions,
  HarnessMutation,
  ApplyResult,
} from './harness.js'

export { harnessToConfig, runTask } from './runner.js'
export type { Task, TaskWorld, RunResult } from './runner.js'

export { evaluate, readTrajectory, DEFAULT_WEIGHTS } from './evaluator.js'
export type {
  EvalResult,
  EvalWeights,
  GoalCheck,
  Trajectory,
  ToolExchange,
} from './evaluator.js'

export { ruleMetaAgent, llmMetaAgent, parseProposal } from './meta-agent.js'
export type { MetaAgent, Proposal, RuleMetaAgentOptions } from './meta-agent.js'

export { evolve, formatEvolveReport } from './evolve.js'
export type { EvolveOptions, EvolveResult, EvolveRound } from './evolve.js'
