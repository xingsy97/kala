/**
 * The evaluator — the out-of-loop judge.
 *
 * `evaluate(logPath, task)` reads a finished session's JSONL log (via the
 * host's public `readSessionLog`) and returns a score in [0, 1] plus a
 * weakness breakdown. It is a strict *consumer* of the log, downstream of the
 * run: the agent under test cannot influence it while running, and — critically
 * — the meta-agent is handed only the returned `EvalResult`, never this module.
 * That structural separation is what stops "improvement" from collapsing into
 * reward hacking (ADR 0015). In production the evaluator should be promoted to
 * its own process; here it is an isolated module the orchestrator alone calls.
 *
 * The score combines generic trajectory signals every coding task shares
 * (did it finish, how many tool errors, how many turns) with a task-specific
 * `goalCheck` that reads the same parsed log. Everything flows through the log,
 * so the judge sees exactly what was durably recorded — nothing more.
 */

import { readSessionLog } from '@agent-kernel/host'
import type { AgentEvent } from '@agent-kernel/kernel'

/** A tool call + its result, reconstructed from the log for goal checks. */
export type ToolExchange = {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly ok: boolean
  readonly content: string
}

/**
 * The task-facing view of a finished run, distilled from the JSONL log. A
 * task's `goalCheck` reads this to decide whether the goal was met — it never
 * touches the live world, only the durable record.
 */
export type Trajectory = {
  readonly finished: boolean
  readonly errored: boolean
  readonly turns: number
  readonly toolErrors: number
  readonly exchanges: readonly ToolExchange[]
  /** Final assistant text (the agent's closing message), if any. */
  readonly finalText: string
}

export type GoalCheck = (traj: Trajectory) => { met: boolean; detail: string }

export type EvalWeights = {
  /** Weight of the task goal being met (the dominant term). */
  readonly goal: number
  /** Penalty per tool error, subtracted from the score. */
  readonly perToolError: number
  /** Penalty per turn beyond `idealTurns`. */
  readonly perExtraTurn: number
  /** Turn count at/under which no efficiency penalty applies. */
  readonly idealTurns: number
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  goal: 1,
  perToolError: 0.15,
  perExtraTurn: 0.05,
  idealTurns: 2,
}

export type EvalResult = {
  readonly score: number
  readonly passed: boolean
  readonly breakdown: {
    readonly goalMet: boolean
    readonly goalDetail: string
    readonly turns: number
    readonly toolErrors: number
    readonly finished: boolean
    readonly errored: boolean
    /** Human-readable weakest link, for the meta-agent's perception channel. */
    readonly weakestLink: string
  }
}

/** Reconstruct the task-facing trajectory from a raw JSONL log. */
export async function readTrajectory(logPath: string): Promise<Trajectory> {
  const log = await readSessionLog(logPath)

  const exchanges: ToolExchange[] = []
  // Pair each tool_call (from an assistant llm_response) with the matching
  // tool_result event by callId.
  const callById = new Map<string, { name: string; input: Record<string, unknown> }>()
  let turns = 0
  let finalText = ''

  for (const entry of log.events) {
    const event: AgentEvent = entry.event
    if (event.kind === 'llm_response') {
      turns += 1
      for (const block of event.message.content) {
        if (block.type === 'tool_call') {
          callById.set(block.callId, { name: block.name, input: block.input })
        } else if (block.type === 'text') {
          finalText = block.text
        }
      }
    } else if (event.kind === 'tool_result') {
      const call = callById.get(event.callId)
      exchanges.push({
        name: call?.name ?? '(unknown)',
        input: call?.input ?? {},
        ok: event.ok,
        content: event.content,
      })
    }
  }

  const finalStatus = log.snapshots.at(-1)?.state.status
  // Fall back to the last event to infer terminal status when no snapshot.
  const finished = finalStatus === 'done' || finalStatus === 'error' || log.events.length > 0
  const errored =
    finalStatus === 'error' || log.events.some((e) => e.event.kind === 'llm_error')
  const toolErrors = exchanges.filter((x) => !x.ok).length

  return {
    finished,
    errored,
    turns,
    toolErrors,
    exchanges,
    finalText,
  }
}

/**
 * Score a finished run. `goalCheck` is supplied by the task; weights default to
 * `DEFAULT_WEIGHTS`. The score is clamped to [0, 1].
 */
export async function evaluate(
  logPath: string,
  goalCheck: GoalCheck,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): Promise<EvalResult> {
  const traj = await readTrajectory(logPath)
  const goal = goalCheck(traj)

  let score = goal.met ? weights.goal : 0
  score -= traj.toolErrors * weights.perToolError
  const extraTurns = Math.max(0, traj.turns - weights.idealTurns)
  score -= extraTurns * weights.perExtraTurn
  if (traj.errored) score -= 0.25
  score = clamp01(score)

  const weakestLink = !goal.met
    ? `goal not met: ${goal.detail}`
    : traj.toolErrors > 0
      ? `${traj.toolErrors} tool error(s) — e.g. ${firstError(traj)}`
      : extraTurns > 0
        ? `inefficient: ${traj.turns} turns (ideal ${weights.idealTurns})`
        : 'none — goal met cleanly'

  return {
    score,
    passed: goal.met && traj.toolErrors === 0,
    breakdown: {
      goalMet: goal.met,
      goalDetail: goal.detail,
      turns: traj.turns,
      toolErrors: traj.toolErrors,
      finished: traj.finished,
      errored: traj.errored,
      weakestLink,
    },
  }
}

function firstError(traj: Trajectory): string {
  const e = traj.exchanges.find((x) => !x.ok)
  if (!e) return ''
  return `${e.name}: ${e.content.slice(0, 80)}`
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}
