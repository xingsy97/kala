/**
 * The meta-agent — proposes a bounded harness mutation from a trajectory.
 *
 * A meta-agent perceives a finished run through two channels only: the
 * `Trajectory` (reconstructed from the JSONL log) and the `EvalResult` the
 * orchestrator hands it (a score + weakness breakdown). It has NO reference to
 * the evaluator module — it cannot read or influence how it is judged, only
 * react to the verdict. Its output is a single `HarnessMutation` (or null when
 * it sees nothing worth changing), never raw code. That keeps every
 * self-improvement step inspectable and inside the harness boundary (ADR 0015).
 *
 * Two strategies implement the same `MetaAgent` interface:
 *
 *   - `ruleMetaAgent` — deterministic, needs no API key. Maps the weakest link
 *     in the breakdown to a targeted mutation. Backs the reproducible
 *     experiment and the unit tests.
 *   - `llmMetaAgent` — prompts a real model (any `LLMAdapter`) with the
 *     trajectory + weakness and parses back a mutation. Same output type, so it
 *     drops into the same evolve loop unchanged.
 */

import type { LLMAdapter } from '@agent-kernel/host'

import type { Harness, HarnessMutation } from './harness.js'
import type { EvalResult, Trajectory } from './evaluator.js'

export type Proposal = {
  readonly mutation: HarnessMutation
  /** Why the meta-agent thinks this helps — shown in evolve reports. */
  readonly rationale: string
}

export type MetaAgent = {
  readonly name: string
  /**
   * Given the current harness and how it just performed, propose one bounded
   * change to try — or null to signal "I have no improvement to offer" (the
   * evolve loop treats a run of nulls as convergence).
   */
  propose(
    harness: Harness,
    traj: Trajectory,
    evalResult: EvalResult,
  ): Promise<Proposal | null>
}

// ---------------------------------------------------------------------------
// Rule-based meta-agent (deterministic, no LLM)
// ---------------------------------------------------------------------------

export type RuleMetaAgentOptions = {
  /**
   * Task-specific hints the rule agent can reach for. `missingInstruction`
   * is appended to the system prompt when the goal is unmet — the canonical
   * "the agent didn't know it should do X" fix. Kept as data so the same rule
   * engine serves any task.
   */
  readonly missingInstruction?: string
  /** A tool description upgrade to try, keyed by tool name. */
  readonly toolHint?: { readonly tool: string; readonly description: string }
}

/**
 * A deterministic proposer. It reads the weakness breakdown and picks the
 * highest-leverage bounded mutation:
 *
 *   goal unmet          → append the missing instruction to the system prompt
 *   tool errors present → sharpen the offending tool's description
 *   inefficient (turns) → nudge the prompt toward directness
 *
 * The choices are intentionally legible: this is the reference proposer, and a
 * reader should be able to predict its move from the breakdown.
 */
export function ruleMetaAgent(options: RuleMetaAgentOptions = {}): MetaAgent {
  return {
    name: 'rule-based',
    async propose(harness, traj, evalResult) {
      const b = evalResult.breakdown

      // 1. Goal unmet is the top priority — the agent lacks a key instruction.
      if (!b.goalMet && options.missingInstruction) {
        if (!harness.systemPrompt.includes(options.missingInstruction)) {
          return {
            mutation: { kind: 'append_system_prompt', text: options.missingInstruction },
            rationale: 'goal unmet — teaching the agent the missing step via the system prompt',
          }
        }
      }

      // 2. Tool errors — the model is misusing a tool; sharpen its description.
      if (b.toolErrors > 0 && options.toolHint) {
        const current = harness.tools.find((t) => t.name === options.toolHint!.tool)
        if (current && current.description !== options.toolHint.description) {
          return {
            mutation: {
              kind: 'set_tool_description',
              tool: options.toolHint.tool,
              description: options.toolHint.description,
            },
            rationale: `${b.toolErrors} tool error(s) — clarifying how to call ${options.toolHint.tool}`,
          }
        }
      }

      // 3. Inefficiency — same failure signature can't be fixed further here.
      // Nothing left to try.
      return null
    },
  }
}

// ---------------------------------------------------------------------------
// LLM-driven meta-agent (real model behind the same interface)
// ---------------------------------------------------------------------------

const META_SYSTEM_PROMPT = [
  'You improve a coding agent by proposing ONE small change to its "harness"',
  '(its system prompt, tool descriptions, or a bounded knob). You are given how',
  'the agent just performed on a task and where it fell short.',
  '',
  'Respond with ONLY a JSON object, no prose, no fences, matching one of:',
  '  {"kind":"append_system_prompt","text":"…","rationale":"…"}',
  '  {"kind":"set_tool_description","tool":"…","description":"…","rationale":"…"}',
  '  {"kind":"drop_tool","tool":"…","rationale":"…"}',
  '  {"kind":"set_extension_knob","knob":"compactionHardThreshold|hooksEnabled","value":<num|bool>,"rationale":"…"}',
  '',
  'Prefer the smallest change that addresses the weakest link. If nothing is',
  'worth changing, respond {"kind":"none"}.',
].join('\n')

/**
 * A meta-agent backed by a real model. Prompts `llm` with the trajectory +
 * weakness breakdown and parses the JSON reply into a `HarnessMutation`. Uses
 * the exact same `LLMAdapter` the host uses, so any configured provider works.
 * Malformed replies degrade to `null` (no proposal) rather than throwing.
 */
export function llmMetaAgent(llm: LLMAdapter, model?: string): MetaAgent {
  return {
    name: `llm(${llm.name})`,
    async propose(harness, traj, evalResult) {
      const summary = renderContext(harness, traj, evalResult)
      const res = await llm.call({
        ...(model ? { model } : {}),
        systemPrompt: META_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: summary }] }],
        tools: [],
      })
      const text = res.message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim()
      return parseProposal(text)
    },
  }
}

function renderContext(harness: Harness, traj: Trajectory, evalResult: EvalResult): string {
  const tools = harness.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
  const exchanges = traj.exchanges
    .map((x) => `  ${x.ok ? 'OK ' : 'ERR'} ${x.name}(${JSON.stringify(x.input)}) -> ${x.content.slice(0, 120)}`)
    .join('\n')
  return [
    `Score: ${evalResult.score.toFixed(2)} (passed: ${evalResult.passed})`,
    `Weakest link: ${evalResult.breakdown.weakestLink}`,
    `Goal met: ${evalResult.breakdown.goalMet} — ${evalResult.breakdown.goalDetail}`,
    `Turns: ${traj.turns}, tool errors: ${traj.toolErrors}`,
    '',
    'Current system prompt:',
    harness.systemPrompt,
    '',
    'Tools offered:',
    tools,
    '',
    'What the agent did:',
    exchanges || '  (no tool calls)',
  ].join('\n')
}

/** Parse the model's JSON reply into a Proposal. Returns null on any mismatch. */
export function parseProposal(raw: string): Proposal | null {
  const stripped = stripFences(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const kind = obj.kind
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : 'proposed by LLM meta-agent'

  if (kind === 'none') return null
  if (kind === 'append_system_prompt' && typeof obj.text === 'string') {
    return { mutation: { kind, text: obj.text }, rationale }
  }
  if (
    kind === 'set_tool_description' &&
    typeof obj.tool === 'string' &&
    typeof obj.description === 'string'
  ) {
    return { mutation: { kind, tool: obj.tool, description: obj.description }, rationale }
  }
  if (kind === 'drop_tool' && typeof obj.tool === 'string') {
    return { mutation: { kind, tool: obj.tool }, rationale }
  }
  if (
    kind === 'set_extension_knob' &&
    (obj.knob === 'compactionHardThreshold' || obj.knob === 'hooksEnabled') &&
    (typeof obj.value === 'number' || typeof obj.value === 'boolean')
  ) {
    return { mutation: { kind, knob: obj.knob, value: obj.value }, rationale }
  }
  return null
}

function stripFences(text: string): string {
  const t = text.trim()
  if (!t.startsWith('```')) return t
  return t.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
}
