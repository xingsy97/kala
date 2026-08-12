import { describe, expect, it } from 'vitest'

import type { Message } from '@agent-kernel/kernel'
import { projectSessionPreviewItems } from './session-preview-items.js'

const messages: Message[] = [{
  role: 'assistant',
  content: [{
    type: 'text',
    text: 'Architecture\n```mermaid\ngraph TD\nA-->B\n```\nImplementation\n```typescript\nconst x = 1\n```',
  }],
}]

describe('projectSessionPreviewItems', () => {
  it('omits complex fenced content without mounting its body', () => {
    const items = projectSessionPreviewItems(messages, [], '')
    expect(items.map((item) => item.label)).toEqual(['Assistant', 'Diagram', 'Assistant', 'typescript code'])
    expect(items.map((item) => item.text).join(' ')).not.toContain('graph TD')
    expect(items.filter((item) => item.kind === 'omitted')).toHaveLength(2)
  })

  it('uses a bounded recent timeline and keeps tool intent', () => {
    const timeline = Array.from({ length: 16 }, (_, index) => ({
      seq: index + 1,
      ts: '2026-08-09T00:00:00.000Z',
      event: { kind: 'user_message' as const, text: `message-${index + 1}` },
      effects: [],
    }))
    timeline.push({
      seq: 17,
      ts: '2026-08-09T00:00:01.000Z',
      event: {
        kind: 'llm_response' as const,
        message: { role: 'assistant' as const, content: [{ type: 'tool_call' as const, callId: 'c1', name: 'read', input: { path: '/repo/a.ts' }, intent: 'Inspect the target implementation.' }] },
      },
      effects: [],
    })
    const items = projectSessionPreviewItems([], timeline, '')
    expect(items).toHaveLength(12)
    expect(items[0]?.text).toBe('message-6')
    expect(items.at(-1)?.text).toBe('Inspect the target implementation.')
  })
})
