/**
 * The task runner — the "fork an isolated world, run one session under a given
 * harness" step of an auto-evolve iteration.
 *
 * `runTask(harness, task, llm)`:
 *   1. forks an isolated `sessionsDir` (temp dir) so the run can't disturb the
 *      baseline or any sibling candidate,
 *   2. compiles the harness into an `AgentConfig` (system prompt + tools +
 *      the compaction knob),
 *   3. drives exactly one session to a terminal state through the real
 *      `runHostLoop` — the same host loop production uses, unchanged,
 *   4. returns the JSONL log path and final state for the evaluator to read.
 *
 * The LLM and the per-task tool world are injected, so a run is fully
 * deterministic given a scripted LLM. Nothing here touches the kernel or host
 * internals; it consumes only `@agent-kernel/host`'s public API.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentConfig, AgentState, CallToolEffect } from '@agent-kernel/kernel'
import { runHostLoop, SessionStore } from '@agent-kernel/host'
import type { LLMAdapter } from '@agent-kernel/host'
import { ulid } from 'ulid'

import type { Harness } from './harness.js'

/**
 * Executes a single tool call in the task's simulated world. Returns the
 * tool_result body the agent will see. This is where a task defines what its
 * tools actually *do* (write a file, run a check, …) without needing a real
 * executor process — the substrate experiments run in-memory for
 * reproducibility.
 */
export type TaskWorld = {
  callTool(effect: CallToolEffect): Promise<{ ok: boolean; content: string }>
}

export type Task = {
  /** Stable id, used in report lines. */
  readonly id: string
  /** One-line human description of the goal. */
  readonly goal: string
  /** The opening user message that kicks the session off. */
  readonly prompt: string
  /**
   * Build a fresh simulated world for one run. Called once per `runTask` so
   * runs never share mutable state. The world may close over its own scratch
   * state (files written, checks run) that the evaluator later inspects via
   * the returned handle.
   */
  makeWorld(): TaskWorld
}

export type RunResult = {
  readonly sessionId: string
  readonly logPath: string
  readonly finalState: AgentState
  /** How many assistant turns the session took (LLM responses observed). */
  readonly turns: number
}

/**
 * Compile a harness into the kernel's `AgentConfig`. The harness is the
 * meta-agent-facing view; `AgentConfig` is what the kernel consumes. This is
 * the one-way bridge between the two.
 */
export function harnessToConfig(harness: Harness): AgentConfig {
  return {
    tools: harness.tools,
    systemPrompt: harness.systemPrompt,
    contextLimit: 200_000,
    hardThreshold: harness.extensions.compactionHardThreshold,
  }
}

/**
 * Run one session under `harness` against `task`, driven by `llm`. Forks and
 * tears down its own isolated sessionsDir. `keepSessionsDir` (for debugging)
 * skips the cleanup and returns the live path.
 */
export async function runTask(
  harness: Harness,
  task: Task,
  llm: LLMAdapter,
  opts: { keepSessionsDir?: boolean } = {},
): Promise<RunResult> {
  const sessionsDir = await mkdtemp(join(tmpdir(), 'ak-substrate-run-'))
  const store = new SessionStore(sessionsDir)
  const world = task.makeWorld()
  const config = harnessToConfig(harness)
  const sessionId = `evolve-${ulid()}`

  let turns = 0

  try {
    await store.create({ config, sessionId })

    const loop = runHostLoop({
      store,
      llm,
      tools: {
        async callTool(_sid, effect) {
          return world.callTool(effect)
        },
        cancelPending() {},
      },
      broadcast: {
        onEvent(_sid, _seq, event) {
          if (event.kind === 'llm_response') turns += 1
        },
        onApprovalRequired() {},
        onError() {},
      },
      // Sub-agent sessions would force allow_all; a plain task runs in the
      // default 'auto' mode, and the task's tools declare requiresApproval:
      // false so nothing blocks on a human.
    })

    await loop.dispatch(sessionId, { kind: 'user_message', text: task.prompt })

    const record = store.get(sessionId)
    if (!record) throw new Error(`session vanished: ${sessionId}`)
    const logPath = record.logPath
    const finalState = record.state

    return { sessionId, logPath, finalState, turns }
  } finally {
    if (!opts.keepSessionsDir) {
      await rm(sessionsDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
