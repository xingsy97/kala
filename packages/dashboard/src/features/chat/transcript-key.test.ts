import { describe, expect, it } from 'vitest'
import { transcriptItemKey } from './transcript-key.js'

describe('transcriptItemKey', () => {
  it('keeps the same row key when a streaming assistant becomes persisted', () => {
    const streaming = { kind: 'message' as const, streaming: true, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'draft' }] } }
    const persisted = { kind: 'message' as const, seq: 9, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] } }
    expect(transcriptItemKey(streaming, 3)).toBe(transcriptItemKey(persisted, 3))
  })
})
