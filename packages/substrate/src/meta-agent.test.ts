import { describe, expect, it } from 'vitest'

import { ruleMetaAgent, llmMetaAgent, parseProposal } from './meta-agent.js'
import { runTask } from './runner.js'
import { evaluate, readTrajectory } from './evaluator.js'
import {
  seedHarness,
  configTask,
  configGoalCheck,
  scriptedConfigLlm,
  KEY_INSTRUCTION,
} from './fixtures.js'
import type { LLMAdapter, LLMResponse } from '@agent-kernel/host'

async function seedContext() {
  const run = await runTask(seedHarness(), configTask, scriptedConfigLlm(), {
    keepSessionsDir: true,
  })
  const traj = await readTrajectory(run.logPath)
  const evalResult = await evaluate(run.logPath, configGoalCheck)
  return { traj, evalResult }
}

describe('parseProposal', () => {
  it('parses an append_system_prompt object', () => {
    const p = parseProposal('{"kind":"append_system_prompt","text":"do X","rationale":"why"}')
    expect(p?.mutation).toEqual({ kind: 'append_system_prompt', text: 'do X' })
    expect(p?.rationale).toBe('why')
  })

  it('parses inside ```json fences', () => {
    const p = parseProposal('```json\n{"kind":"drop_tool","tool":"foo"}\n```')
    expect(p?.mutation).toEqual({ kind: 'drop_tool', tool: 'foo' })
  })

  it('returns null for {"kind":"none"}', () => {
    expect(parseProposal('{"kind":"none"}')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseProposal('not json')).toBeNull()
  })

  it('returns null for an unknown kind', () => {
    expect(parseProposal('{"kind":"rewrite_kernel"}')).toBeNull()
  })

  it('validates set_extension_knob shape', () => {
    const ok = parseProposal('{"kind":"set_extension_knob","knob":"hooksEnabled","value":true}')
    expect(ok?.mutation).toEqual({ kind: 'set_extension_knob', knob: 'hooksEnabled', value: true })
    const bad = parseProposal('{"kind":"set_extension_knob","knob":"nope","value":1}')
    expect(bad).toBeNull()
  })
})

describe('ruleMetaAgent', () => {
  it('proposes appending the missing instruction when the goal is unmet', async () => {
    const { traj, evalResult } = await seedContext()
    const agent = ruleMetaAgent({ missingInstruction: KEY_INSTRUCTION })
    const proposal = await agent.propose(seedHarness(), traj, evalResult)
    expect(proposal?.mutation).toEqual({
      kind: 'append_system_prompt',
      text: KEY_INSTRUCTION,
    })
  })

  it('returns null when it has already applied its instruction', async () => {
    const { traj, evalResult } = await seedContext()
    const agent = ruleMetaAgent({ missingInstruction: KEY_INSTRUCTION })
    // Harness that already contains the instruction  -  but note the eval result
    // here is the seed's (goal unmet). The rule agent must not re-propose the
    // same text it already sees in the prompt.
    const harnessWithInstruction = {
      ...seedHarness(),
      systemPrompt: `${seedHarness().systemPrompt}\n${KEY_INSTRUCTION}`,
    }
    const proposal = await agent.propose(harnessWithInstruction, traj, evalResult)
    expect(proposal).toBeNull()
  })

  it('returns null with no hints configured', async () => {
    const { traj, evalResult } = await seedContext()
    const agent = ruleMetaAgent()
    expect(await agent.propose(seedHarness(), traj, evalResult)).toBeNull()
  })
})

describe('llmMetaAgent', () => {
  it('turns a model JSON reply into a proposal', async () => {
    const stub: LLMAdapter = {
      name: 'stub',
      async call(): Promise<LLMResponse> {
        return {
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `{"kind":"append_system_prompt","text":"${KEY_INSTRUCTION}","rationale":"goal unmet"}`,
              },
            ],
          },
        }
      },
    }
    const { traj, evalResult } = await seedContext()
    const agent = llmMetaAgent(stub)
    const proposal = await agent.propose(seedHarness(), traj, evalResult)
    expect(proposal?.mutation).toEqual({ kind: 'append_system_prompt', text: KEY_INSTRUCTION })
    expect(agent.name).toBe('llm(stub)')
  })

  it('degrades to null on a non-JSON model reply', async () => {
    const stub: LLMAdapter = {
      name: 'stub',
      async call(): Promise<LLMResponse> {
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'sorry, no' }] } }
      },
    }
    const { traj, evalResult } = await seedContext()
    const agent = llmMetaAgent(stub)
    expect(await agent.propose(seedHarness(), traj, evalResult)).toBeNull()
  })
})
