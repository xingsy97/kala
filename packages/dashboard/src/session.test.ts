import { describe, expect, it } from 'vitest'

import type { TimelineEntry } from './session.js'
import { mergeBySeq } from './session.js'

function entry(seq: number, kind: TimelineEntry['event']['kind']): TimelineEntry {
  if (kind === 'llm_response') {
    return {
      seq,
      ts: `t-${seq}`,
      event: {
        kind,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
      effects: [{ kind: 'finish' }],
    }
  }
  return {
    seq,
    ts: `t-${seq}`,
    event: { kind: 'user_message', text: `m-${seq}` },
    effects: [{ kind: 'call_llm', messages: [], tools: [] }],
  }
}

describe('mergeBySeq', () => {
  it('sorts and fills missing history entries', () => {
    expect(mergeBySeq([entry(3, 'user_message')], [entry(1, 'user_message')]).map((e) => e.seq)).toEqual([1, 3])
  })

  it('does not let conflicting replay data overwrite an existing live event', () => {
    const live = entry(2, 'llm_response')
    const history = entry(2, 'user_message')

    expect(mergeBySeq([live], [history])[0]).toBe(live)
  })

  it('merges llmTrace and model metadata for the same replayed LLM event', () => {
    const live = entry(2, 'llm_response')
    const history: TimelineEntry = {
      ...entry(2, 'llm_response'),
      llmTrace: {
        provider: 'openai',
        model: 'gpt-5.5',
        request: {
          url: 'https://api.example.test/v1/chat/completions',
          headers: { authorization: 'Bearer test-redacted-api-key' },
          body: { model: 'gpt-5.5', messages: [] },
        },
        response: { status: 200, body: { choices: [] } },
      },
      model: 'gpt-5.5',
    }

    const merged = mergeBySeq([live], [history])[0]

    expect(merged?.llmTrace?.model).toBe('gpt-5.5')
    expect(merged?.model).toBe('gpt-5.5')
  })
})
