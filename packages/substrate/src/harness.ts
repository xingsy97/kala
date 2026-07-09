/**
 * The harness spec — the *only* surface a meta-agent may optimize.
 *
 * A `Harness` is plain, serializable data describing the parts of a coding
 * agent's setup that a meta-agent is allowed to change: the system prompt, the
 * tool set (names + descriptions offered to the model), and a small set of
 * bounded extension knobs. It deliberately does NOT include the kernel FSM or
 * the wire protocol — those are the fixed substrate the experiment runs on, not
 * the thing under optimization (see ADR 0015).
 *
 * A meta-agent never emits raw code or patches. It emits a `HarnessMutation` —
 * a small typed delta — and `applyMutation` folds it in as a pure function.
 * Every proposed change is therefore inspectable, bounded, and incapable of
 * reaching anything below the harness layer.
 */

import type { ToolSchema } from '@agent-kernel/kernel'

/**
 * Bounded extension knobs. These map to the host's optional extension layer
 * (compaction, hooks) — capabilities that sit above the kernel and can be
 * tuned without touching core. Kept intentionally small; each field is a
 * scalar a mutation can nudge.
 */
export type HarnessExtensions = {
  /** Ratio of context window at which auto-compaction fires (0–1). */
  readonly compactionHardThreshold: number
  /** Whether pre/post-tool-use hooks are engaged for this harness. */
  readonly hooksEnabled: boolean
}

export type Harness = {
  readonly systemPrompt: string
  readonly tools: readonly ToolSchema[]
  readonly extensions: HarnessExtensions
}

/**
 * A typed, reviewable delta to a harness. This union is the entire vocabulary
 * a meta-agent has. Adding a case here widens what a meta-agent may do; it is
 * the audit point for the programmable surface.
 */
export type HarnessMutation =
  | { readonly kind: 'set_system_prompt'; readonly systemPrompt: string }
  | {
      /**
       * Append guidance to the system prompt (the common case — refine
       * behaviour without discarding what already works).
       */
      readonly kind: 'append_system_prompt'
      readonly text: string
    }
  | {
      /** Sharpen a tool's description so the model wields it better. */
      readonly kind: 'set_tool_description'
      readonly tool: string
      readonly description: string
    }
  | { readonly kind: 'drop_tool'; readonly tool: string }
  | { readonly kind: 'add_tool'; readonly tool: ToolSchema }
  | {
      readonly kind: 'set_extension_knob'
      readonly knob: keyof HarnessExtensions
      readonly value: number | boolean
    }

export type ApplyResult =
  | { readonly ok: true; readonly harness: Harness }
  | { readonly ok: false; readonly reason: string }

/**
 * Fold a mutation into a harness. Pure: never mutates its input, always returns
 * a fresh `Harness`. Returns `{ ok: false }` for mutations that don't apply
 * (unknown tool, wrong value type for a knob) rather than throwing, so an
 * evolve loop can skip a bad proposal and keep going.
 */
export function applyMutation(harness: Harness, mutation: HarnessMutation): ApplyResult {
  switch (mutation.kind) {
    case 'set_system_prompt':
      return { ok: true, harness: { ...harness, systemPrompt: mutation.systemPrompt } }

    case 'append_system_prompt': {
      const sep = harness.systemPrompt.endsWith('\n') ? '' : '\n'
      return {
        ok: true,
        harness: { ...harness, systemPrompt: `${harness.systemPrompt}${sep}${mutation.text}` },
      }
    }

    case 'set_tool_description': {
      const idx = harness.tools.findIndex((t) => t.name === mutation.tool)
      if (idx === -1) return { ok: false, reason: `unknown tool: ${mutation.tool}` }
      const tools = harness.tools.map((t, i) =>
        i === idx ? { ...t, description: mutation.description } : t,
      )
      return { ok: true, harness: { ...harness, tools } }
    }

    case 'drop_tool': {
      if (!harness.tools.some((t) => t.name === mutation.tool)) {
        return { ok: false, reason: `unknown tool: ${mutation.tool}` }
      }
      const tools = harness.tools.filter((t) => t.name !== mutation.tool)
      return { ok: true, harness: { ...harness, tools } }
    }

    case 'add_tool': {
      if (harness.tools.some((t) => t.name === mutation.tool.name)) {
        return { ok: false, reason: `tool already present: ${mutation.tool.name}` }
      }
      return { ok: true, harness: { ...harness, tools: [...harness.tools, mutation.tool] } }
    }

    case 'set_extension_knob': {
      const { knob, value } = mutation
      if (knob === 'compactionHardThreshold') {
        if (typeof value !== 'number' || value <= 0 || value > 1) {
          return { ok: false, reason: 'compactionHardThreshold must be a number in (0, 1]' }
        }
        return {
          ok: true,
          harness: { ...harness, extensions: { ...harness.extensions, compactionHardThreshold: value } },
        }
      }
      if (knob === 'hooksEnabled') {
        if (typeof value !== 'boolean') {
          return { ok: false, reason: 'hooksEnabled must be a boolean' }
        }
        return {
          ok: true,
          harness: { ...harness, extensions: { ...harness.extensions, hooksEnabled: value } },
        }
      }
      return { ok: false, reason: `unknown knob: ${String(knob)}` }
    }
  }
}

/** Apply a sequence of mutations, stopping at the first that fails. */
export function applyMutations(
  harness: Harness,
  mutations: readonly HarnessMutation[],
): ApplyResult {
  let current = harness
  for (const m of mutations) {
    const res = applyMutation(current, m)
    if (!res.ok) return res
    current = res.harness
  }
  return { ok: true, harness: current }
}

/** A short human-readable label for logs and evolve reports. */
export function describeMutation(mutation: HarnessMutation): string {
  switch (mutation.kind) {
    case 'set_system_prompt':
      return 'set system prompt'
    case 'append_system_prompt':
      return `append to system prompt: "${truncate(mutation.text, 60)}"`
    case 'set_tool_description':
      return `retune ${mutation.tool} description`
    case 'drop_tool':
      return `drop tool ${mutation.tool}`
    case 'add_tool':
      return `add tool ${mutation.tool.name}`
    case 'set_extension_knob':
      return `set ${mutation.knob} = ${String(mutation.value)}`
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
