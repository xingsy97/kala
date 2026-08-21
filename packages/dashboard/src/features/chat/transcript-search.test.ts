import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../transcript.js'
import { nextSearchMatchIndex, searchMatchSnippet, searchTranscript } from './transcript-search.js'

const items: readonly TranscriptItem[] = [
  { kind: 'message', seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'Find Alpha and alpha again' }] } },
  { kind: 'message', seq: 2, message: { role: 'assistant', content: [{ type: 'thinking', text: 'consider Alpha' }, { type: 'tool_call', callId: 'c1', name: 'grep', intent: 'Search the workspace', input: { pattern: 'Alpha', path: '/tmp' } }] } },
  { kind: 'message', seq: 3, message: { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 'Alpha result' }] } },
  { kind: 'pending_user_message', id: 'pending-1', text: 'pending alpha', mode: 'steer', status: 'sending', createdAt: '2026-01-01T00:00:00.000Z' },
]

describe('transcript search', () => {
  it('finds every case-insensitive occurrence with stable anchors', () => {
    const matches = searchTranscript(items, 'alpha')
    expect(matches).toHaveLength(6)
    expect(matches[0]).toMatchObject({ anchor: 'seq:1', category: 'user', messageIndex: 0 })
    expect(matches.at(-1)).toMatchObject({ anchor: 'pending:pending-1', category: 'user' })
  })

  it('filters thinking and tool content independently', () => {
    expect(searchTranscript(items, 'alpha', 'thinking')).toHaveLength(1)
    const tools = searchTranscript(items, 'alpha', 'tools')
    expect(tools).toHaveLength(2)
    expect(searchTranscript(items, 'workspace', 'tools')[0]?.text).toContain('Search the workspace')
  })

  it('wraps navigation and handles empty results', () => {
    expect(nextSearchMatchIndex(-1, 3, 1)).toBe(0)
    expect(nextSearchMatchIndex(2, 3, 1)).toBe(0)
    expect(nextSearchMatchIndex(0, 3, -1)).toBe(2)
    expect(nextSearchMatchIndex(0, 0, 1)).toBe(-1)
  })

  it('returns bounded readable snippets', () => {
    const match = searchTranscript(items, 'alpha')[0]!
    expect(searchMatchSnippet(match, 5)).toContain('Alpha')
  })
})
