// Export mined bad-cases as JSONL for training. Two formats:
//   SFT: { instruction, trace, gold? }
//   RL:  { prompt, rollout, reward: 0, reason }
// The reward=0 signal for RL is deliberate: we ship failed rollouts so a
// downstream trainer (SLIME / VERL) can use them as negatives; the reason
// field carries the failureCategory so the trainer can bucket them.

import type { BadCase } from './badcase-mining.js'

export function exportForSFT(cases: readonly BadCase[]): string {
  return cases
    .map((c) => JSON.stringify({
      instruction: `Fix instance ${c.instanceId}`,
      trace: {
        head: c.traceHead,
        tail: c.traceTail,
        toolCallErrors: c.toolCallErrors,
      },
      ...(c.verifierReason ? { gold: c.verifierReason } : {}),
    }))
    .join('\n') + (cases.length > 0 ? '\n' : '')
}

export function exportForRL(cases: readonly BadCase[]): string {
  return cases
    .map((c) => JSON.stringify({
      prompt: `Instance ${c.instanceId}: reproduce and fix. Failure category: ${c.failureCategory}.`,
      rollout: {
        head: c.traceHead,
        tail: c.traceTail,
        toolCallErrors: c.toolCallErrors,
      },
      reward: 0,
      reason: c.failureCategory,
    }))
    .join('\n') + (cases.length > 0 ? '\n' : '')
}
