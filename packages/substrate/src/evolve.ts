/**
 * The evolve orchestrator — one complete auto-evolve loop.
 *
 * This is the only component that touches all the others, and it is
 * deliberately the *only* one that calls the evaluator. The meta-agent is
 * handed the evaluator's *result*, never the evaluator itself — the boundary
 * that keeps self-improvement from turning into reward hacking lives here, as a
 * structural fact of who calls whom (ADR 0015).
 *
 * Each round:
 *   1. run the current best harness on the task (isolated world)   [runner]
 *   2. score the run from its JSONL log                            [evaluator]
 *   3. if optimal or out of budget, stop
 *   4. ask the meta-agent for one bounded mutation                 [meta-agent]
 *   5. apply it; if the candidate scores higher, adopt it          [harness]
 *      else count a stall; give up after `patience` stalls
 *
 * The best harness ever seen is always retained, so evolution never regresses
 * below the seed.
 */

import type { LLMAdapter } from '@agent-kernel/host'

import { applyMutation, describeMutation } from './harness.js'
import type { Harness } from './harness.js'
import { evaluate, readTrajectory } from './evaluator.js'
import type { EvalResult, EvalWeights, GoalCheck } from './evaluator.js'
import { runTask } from './runner.js'
import type { Task } from './runner.js'
import type { MetaAgent } from './meta-agent.js'

export type EvolveRound = {
  readonly round: number
  readonly score: number
  readonly passed: boolean
  readonly weakestLink: string
  /** The mutation applied to PRODUCE the harness this round ran (round > 0). */
  readonly appliedMutation?: string
  readonly rationale?: string
  /** Whether this round's harness was adopted as the new best. */
  readonly adopted: boolean
}

export type EvolveResult = {
  readonly seedScore: number
  readonly bestScore: number
  readonly improved: boolean
  readonly bestHarness: Harness
  readonly rounds: readonly EvolveRound[]
  readonly stoppedReason: 'optimal' | 'budget' | 'converged'
}

export type EvolveOptions = {
  readonly seed: Harness
  readonly task: Task
  readonly llm: LLMAdapter
  readonly metaAgent: MetaAgent
  readonly goalCheck: GoalCheck
  /** Max evolve rounds (including the seed run). Default 6. */
  readonly maxRounds?: number
  /** Stop after this many non-improving proposals in a row. Default 2. */
  readonly patience?: number
  /** Score at/above which we declare success and stop. Default 0.999. */
  readonly optimalScore?: number
  readonly weights?: EvalWeights
  /** Optional progress sink for a live report. */
  readonly onRound?: (round: EvolveRound) => void
}

/**
 * Score one harness on the task: run it, then evaluate the resulting log. This
 * pairs the runner and evaluator, and is the unit the loop repeats. Note the
 * meta-agent is nowhere in here — scoring is entirely the orchestrator's job.
 */
async function scoreHarness(
  harness: Harness,
  opts: EvolveOptions,
): Promise<{ evalResult: EvalResult; logPath: string }> {
  const run = await runTask(harness, opts.task, opts.llm, { keepSessionsDir: true })
  const evalResult = await evaluate(run.logPath, opts.goalCheck, opts.weights)
  return { evalResult, logPath: run.logPath }
}

export async function evolve(opts: EvolveOptions): Promise<EvolveResult> {
  const maxRounds = opts.maxRounds ?? 6
  const patience = opts.patience ?? 2
  const optimalScore = opts.optimalScore ?? 0.999

  const rounds: EvolveRound[] = []

  // Round 0: the seed.
  let best = opts.seed
  let bestScored = await scoreHarness(best, opts)
  const seedScore = bestScored.evalResult.score

  const seedRound: EvolveRound = {
    round: 0,
    score: seedScore,
    passed: bestScored.evalResult.passed,
    weakestLink: bestScored.evalResult.breakdown.weakestLink,
    adopted: true,
  }
  rounds.push(seedRound)
  opts.onRound?.(seedRound)

  let stalls = 0
  let stoppedReason: EvolveResult['stoppedReason'] = 'budget'

  for (let round = 1; round < maxRounds; round++) {
    if (bestScored.evalResult.score >= optimalScore) {
      stoppedReason = 'optimal'
      break
    }

    // Perception for the meta-agent comes from the log + eval result only.
    const traj = await readTrajectory(bestScored.logPath)
    const proposal = await opts.metaAgent.propose(best, traj, bestScored.evalResult)

    if (!proposal) {
      stoppedReason = 'converged'
      break
    }

    const applied = applyMutation(best, proposal.mutation)
    if (!applied.ok) {
      // The proposer suggested something invalid; treat as a stall.
      stalls += 1
      const stallRound: EvolveRound = {
        round,
        score: bestScored.evalResult.score,
        passed: bestScored.evalResult.passed,
        weakestLink: `rejected mutation: ${applied.reason}`,
        appliedMutation: describeMutation(proposal.mutation),
        rationale: proposal.rationale,
        adopted: false,
      }
      rounds.push(stallRound)
      opts.onRound?.(stallRound)
      if (stalls >= patience) {
        stoppedReason = 'converged'
        break
      }
      continue
    }

    const candidate = applied.harness
    const candidateScored = await scoreHarness(candidate, opts)
    const adopted = candidateScored.evalResult.score > bestScored.evalResult.score

    const thisRound: EvolveRound = {
      round,
      score: candidateScored.evalResult.score,
      passed: candidateScored.evalResult.passed,
      weakestLink: candidateScored.evalResult.breakdown.weakestLink,
      appliedMutation: describeMutation(proposal.mutation),
      rationale: proposal.rationale,
      adopted,
    }
    rounds.push(thisRound)
    opts.onRound?.(thisRound)

    if (adopted) {
      best = candidate
      bestScored = candidateScored
      stalls = 0
    } else {
      stalls += 1
      if (stalls >= patience) {
        stoppedReason = 'converged'
        break
      }
    }
  }

  if (bestScored.evalResult.score >= optimalScore) stoppedReason = 'optimal'

  return {
    seedScore,
    bestScore: bestScored.evalResult.score,
    improved: bestScored.evalResult.score > seedScore,
    bestHarness: best,
    rounds,
    stoppedReason,
  }
}

/** Render an evolve result as a compact human-readable report. */
export function formatEvolveReport(result: EvolveResult): string {
  const lines: string[] = []
  lines.push('=== auto-evolve report ===')
  for (const r of result.rounds) {
    const tag = r.round === 0 ? 'seed' : r.adopted ? 'ADOPT' : 'reject'
    const mut = r.appliedMutation ? ` | ${r.appliedMutation}` : ''
    lines.push(
      `round ${r.round} [${tag}] score=${r.score.toFixed(2)} passed=${r.passed}${mut}`,
    )
    if (r.rationale) lines.push(`         ↳ ${r.rationale}`)
    lines.push(`         weakest: ${r.weakestLink}`)
  }
  lines.push('---')
  lines.push(
    `seed ${result.seedScore.toFixed(2)} → best ${result.bestScore.toFixed(2)} ` +
      `(${result.improved ? 'IMPROVED' : 'no gain'}), stopped: ${result.stoppedReason}`,
  )
  return lines.join('\n')
}
