/**
 * Shared test + example fixture: a concrete task whose agent behaviour depends
 * on the harness, plus a scripted LLM that models "a better prompt yields a
 * better agent".
 *
 * The task: create `config.json` containing valid JSON. The world offers two
 * tools  -  `write_file` and `validate_json`. The scripted LLM reads the system
 * prompt and behaves accordingly, exactly the way a real model would:
 *
 *   - Without the key instruction, the agent writes JSON with a trailing comma
 *     (a classic LLM mistake), never validates, and declares done. The file is
 *     invalid  -  the goal is not met.
 *   - Once the system prompt tells it to emit strictly valid JSON and validate
 *     before finishing, it writes clean JSON, calls `validate_json`, sees OK,
 *     and finishes. Goal met, no tool errors.
 *
 * This makes the auto-evolve experiment meaningful: evolving the harness
 * changes the agent's observable behaviour and therefore its score.
 */

import type { LLMAdapter, LLMResponse } from '@agent-kernel/host'
import type { Message } from '@agent-kernel/kernel'

import type { Harness } from './harness.js'
import type { GoalCheck, Trajectory } from './evaluator.js'
import type { Task, TaskWorld } from './runner.js'

export const WRITE_FILE_TOOL = {
  name: 'write_file',
  description: 'write text to a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  requiresApproval: false,
} as const

export const VALIDATE_JSON_TOOL = {
  name: 'validate_json',
  description: 'check whether a file contains valid JSON',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  requiresApproval: false,
} as const

/** The marker instruction a good harness must contain. */
export const KEY_INSTRUCTION =
  'Produce strictly valid JSON (no trailing commas) and call validate_json before finishing.'

/** The seed (deliberately weak) harness the experiment starts from. */
export function seedHarness(): Harness {
  return {
    systemPrompt: 'You are a coding agent. Create files as requested.',
    tools: [WRITE_FILE_TOOL, VALIDATE_JSON_TOOL],
    extensions: { compactionHardThreshold: 0.92, hooksEnabled: false },
  }
}

/** The world: an in-memory filesystem + a real JSON validator. */
export function makeConfigWorld(): TaskWorld & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async callTool(effect) {
      if (effect.name === 'write_file') {
        const path = String(effect.input.path ?? '')
        const content = String(effect.input.content ?? '')
        files.set(path, content)
        return { ok: true, content: `wrote ${content.length} bytes to ${path}` }
      }
      if (effect.name === 'validate_json') {
        const path = String(effect.input.path ?? '')
        const content = files.get(path)
        if (content === undefined) {
          return { ok: false, content: `ERROR: no such file: ${path}` }
        }
        try {
          JSON.parse(content)
          return { ok: true, content: 'valid JSON' }
        } catch (err) {
          return { ok: false, content: `ERROR: invalid JSON: ${(err as Error).message}` }
        }
      }
      return { ok: false, content: `ERROR: unknown tool: ${effect.name}` }
    },
  }
}

export const configTask: Task = {
  id: 'create-valid-config',
  goal: 'Create config.json containing valid JSON',
  prompt: 'Create a file config.json with a JSON object {"name":"app","version":1}.',
  makeWorld: makeConfigWorld,
}

/**
 * The goal check the evaluator runs. Reads the trajectory (from the log): the
 * goal is met iff a validate_json call succeeded on config.json. A run that
 * never validates, or validates and fails, does not meet the goal.
 */
export const configGoalCheck: GoalCheck = (traj: Trajectory) => {
  const validated = traj.exchanges.find(
    (x) => x.name === 'validate_json' && x.input.path === 'config.json',
  )
  if (!validated) return { met: false, detail: 'never validated config.json' }
  if (!validated.ok) return { met: false, detail: `validation failed: ${validated.content}` }
  return { met: true, detail: 'config.json validated as valid JSON' }
}

/**
 * A scripted LLM whose behaviour is a pure function of the harness system
 * prompt. This is the crux of the reproducible experiment: it emits *good*
 * tool calls when the prompt carries the key instruction, and *buggy* ones
 * otherwise  -  no randomness, no network.
 *
 * The adapter inspects the system prompt on each call and drives a tiny
 * two-step script keyed off how many assistant turns have happened (derived
 * from the message history).
 */
export function scriptedConfigLlm(): LLMAdapter {
  return {
    name: 'scripted-config',
    async call(params): Promise<LLMResponse> {
      const knows = (params.systemPrompt ?? '').includes(KEY_INSTRUCTION)
      const assistantTurns = params.messages.filter((m: Message) => m.role === 'assistant').length
      const validatedOk = hasSuccessfulValidation(params.messages)

      // GOOD path: write valid JSON, then validate, then finish.
      if (knows) {
        if (assistantTurns === 0) {
          return textAndCall('Writing config.json with valid JSON.', {
            callId: 'c-write',
            name: 'write_file',
            input: { path: 'config.json', content: '{"name":"app","version":1}' },
          })
        }
        if (assistantTurns === 1) {
          return textAndCall('Validating.', {
            callId: 'c-validate',
            name: 'validate_json',
            input: { path: 'config.json' },
          })
        }
        return justText('Done  -  config.json is valid.')
      }

      // NAIVE path: write JSON with a trailing comma, then declare done.
      if (assistantTurns === 0) {
        return textAndCall('Writing config.json.', {
          callId: 'c-write',
          name: 'write_file',
          // Trailing comma  -  invalid JSON. The naive agent doesn't notice.
          input: { path: 'config.json', content: '{"name":"app","version":1,}' },
        })
      }
      // If somehow validation happened and passed, finish; else declare done
      // without validating (the naive failure mode).
      if (validatedOk) return justText('Done.')
      return justText('Done  -  created config.json.')
    },
  }
}

function hasSuccessfulValidation(messages: readonly Message[]): boolean {
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'tool_result' && block.ok && block.content.includes('valid JSON')) {
        return true
      }
    }
  }
  return false
}

function justText(text: string): LLMResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

function textAndCall(
  text: string,
  call: { callId: string; name: string; input: Record<string, unknown> },
): LLMResponse {
  return {
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool_call', callId: call.callId, name: call.name, input: call.input },
      ],
    },
    usage: { inputTokens: 10, outputTokens: 8 },
  }
}
