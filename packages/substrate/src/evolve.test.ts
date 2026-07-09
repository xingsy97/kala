import { describe, expect, it } from 'vitest'

import { evolve, formatEvolveReport } from './evolve.js'
import { ruleMetaAgent, llmMetaAgent } from './meta-agent.js'
import {
  seedHarness,
  configTask,
  configGoalCheck,
  scriptedConfigLlm,
  KEY_INSTRUCTION,
} from './fixtures.js'
import type { LLMAdapter, LLMResponse } from '@agent-kernel/host'

describe('evolve', () => {
  it('improves the seed harness with the rule-based meta-agent', async () => {
    const result = await evolve({
      seed: seedHarness(),
      task: configTask,
      llm: scriptedConfigLlm(),
      metaAgent: ruleMetaAgent({ missingInstruction: KEY_INSTRUCTION }),
      goalCheck: configGoalCheck,
    })

    // Seed fails the goal; after one mutation the agent validates and passes.
    expect(result.seedScore).toBeLessThan(0.5)
    expect(result.bestScore).toBeGreaterThan(0.8)
    expect(result.improved).toBe(true)

    // The best harness must carry the instruction that fixed it.
    expect(result.bestHarness.systemPrompt).toContain(KEY_INSTRUCTION)

    // Round 0 is the seed; a later round is adopted.
    expect(result.rounds[0]?.round).toBe(0)
    expect(result.rounds.some((r) => r.adopted && r.round > 0)).toBe(true)
  })

  it('stops once the goal is met and the meta-agent has no further fix', async () => {
    const result = await evolve({
      seed: seedHarness(),
      task: configTask,
      llm: scriptedConfigLlm(),
      metaAgent: ruleMetaAgent({ missingInstruction: KEY_INSTRUCTION }),
      goalCheck: configGoalCheck,
    })
    // The good harness meets the goal but takes one turn more than ideal, so
    // its score is high yet below optimalScore; the rule agent then offers
    // nothing more, so the loop converges rather than declaring perfection.
    expect(result.stoppedReason).toBe('converged')
    expect(result.bestScore).toBeGreaterThan(0.8)
    expect(result.bestHarness.systemPrompt).toContain(KEY_INSTRUCTION)
  })

  it('converges (no crash) when the meta-agent offers nothing', async () => {
    const result = await evolve({
      seed: seedHarness(),
      task: configTask,
      llm: scriptedConfigLlm(),
      metaAgent: ruleMetaAgent(), // no hints -> always null
      goalCheck: configGoalCheck,
    })
    expect(result.stoppedReason).toBe('converged')
    expect(result.improved).toBe(false)
    expect(result.rounds).toHaveLength(1) // only the seed ran
  })

  it('never regresses below the seed even if a mutation does not help', async () => {
    // A meta-agent that proposes a useless (but valid) mutation once, then
    // nothing. The best score must stay >= seed.
    let called = 0
    const uselessAgent = {
      name: 'useless',
      async propose() {
        called += 1
        if (called === 1) {
          return {
            mutation: { kind: 'append_system_prompt' as const, text: 'Be nice.' },
            rationale: 'irrelevant',
          }
        }
        return null
      },
    }
    const result = await evolve({
      seed: seedHarness(),
      task: configTask,
      llm: scriptedConfigLlm(),
      metaAgent: uselessAgent,
      goalCheck: configGoalCheck,
      patience: 1,
    })
    expect(result.bestScore).toBeGreaterThanOrEqual(result.seedScore)
    // The useless mutation was not adopted.
    expect(result.rounds.some((r) => !r.adopted && r.round > 0)).toBe(true)
  })

  it('works end-to-end with an LLM-driven meta-agent (stubbed model)', async () => {
    // The meta-model, when shown the failing trajectory, replies with the fix.
    const metaModel: LLMAdapter = {
      name: 'meta-stub',
      async call(): Promise<LLMResponse> {
        return {
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `{"kind":"append_system_prompt","text":"${KEY_INSTRUCTION}","rationale":"the agent never validated"}`,
              },
            ],
          },
        }
      },
    }
    const result = await evolve({
      seed: seedHarness(),
      task: configTask,
      llm: scriptedConfigLlm(),
      metaAgent: llmMetaAgent(metaModel),
      goalCheck: configGoalCheck,
    })
    expect(result.improved).toBe(true)
    expect(result.bestScore).toBeGreaterThan(0.8)
  })

  it('formatEvolveReport renders a readable summary', async () => {
    const result = await evolve({
      seed: seedHarness(),
      task: configTask,
      llm: scriptedConfigLlm(),
      metaAgent: ruleMetaAgent({ missingInstruction: KEY_INSTRUCTION }),
      goalCheck: configGoalCheck,
    })
    const report = formatEvolveReport(result)
    expect(report).toContain('auto-evolve report')
    expect(report).toContain('IMPROVED')
    expect(report).toContain('round 0 [seed]')
  })
})
