import { describe, expect, it } from 'vitest'

import { parseSubAgentEnvelope } from './subAgentEnvelope.js'

describe('parseSubAgentEnvelope', () => {
  it('parses a completed envelope', () => {
    const raw = [
      '<sub_agent',
      '  session_id="child-42"',
      '  agent_type="Explore"',
      '  intention="Inspect &amp; summarize the relevant behavior."',
      '  status="completed"',
      '  turns="7"',
      '  duration_ms="12345"',
      '>',
      '<result>',
      'hello world',
      '</result>',
      '</sub_agent>',
    ].join('\n')
    const parsed = parseSubAgentEnvelope(raw)
    expect(parsed).toEqual({
      sessionId: 'child-42',
      agentType: 'Explore',
      intention: 'Inspect & summarize the relevant behavior.',
      status: 'completed',
      turns: 7,
      durationMs: 12345,
      body: 'hello world',
    })
  })

  it('parses a failed envelope with an <error> body', () => {
    const raw = [
      '<sub_agent',
      '  session_id="child-99"',
      '  status="failed"',
      '  turns="0"',
      '  duration_ms="42"',
      '>',
      '<error>',
      'agent depth exceeded',
      '</error>',
      '</sub_agent>',
    ].join('\n')
    const parsed = parseSubAgentEnvelope(raw)
    expect(parsed).toEqual({
      sessionId: 'child-99',
      status: 'failed',
      turns: 0,
      durationMs: 42,
      body: 'agent depth exceeded',
    })
  })

  it('parses a cancelled envelope with an <error> body', () => {
    const raw = [
      '<sub_agent',
      '  session_id="child-cancelled"',
      '  status="cancelled"',
      '  turns="2"',
      '  duration_ms="300"',
      '>',
      '<error>',
      'interrupted by user',
      '</error>',
      '</sub_agent>',
    ].join('\n')
    const parsed = parseSubAgentEnvelope(raw)
    expect(parsed).toEqual({
      sessionId: 'child-cancelled',
      status: 'cancelled',
      turns: 2,
      durationMs: 300,
      body: 'interrupted by user',
    })
  })

  it('un-escapes < and > inside the body', () => {
    const raw =
      '<sub_agent session_id="c" status="completed" turns="1" duration_ms="1">\n' +
      '<result>&lt;p&gt;hi&lt;/p&gt;</result>\n</sub_agent>'
    const parsed = parseSubAgentEnvelope(raw)
    expect(parsed?.body).toBe('<p>hi</p>')
  })

  it('parses a timed-out partial result as usable result text', () => {
    const raw = '<sub_agent session_id="child-partial" status="timed_out_with_partial_result" turns="12" duration_ms="3000">\n' +
      '<warning>deadline reached</warning>\n<result>Verified findings so far.</result>\n</sub_agent>'
    expect(parseSubAgentEnvelope(raw)).toMatchObject({
      sessionId: 'child-partial',
      status: 'timed_out_with_partial_result',
      body: 'Verified findings so far.',
    })
  })

  it('returns null for legacy pre-envelope content', () => {
    expect(parseSubAgentEnvelope('just a plain string')).toBeNull()
    expect(parseSubAgentEnvelope('')).toBeNull()
  })

  it('returns null when the header is malformed', () => {
    expect(parseSubAgentEnvelope('<sub_agent session_id="x">')).toBeNull()
    expect(parseSubAgentEnvelope('<sub_agent status="completed">…')).toBeNull()
    expect(parseSubAgentEnvelope('<sub_agent status="what" session_id="x">')).toBeNull()
  })

  it('leaves body empty when the <result>/<error> block is missing', () => {
    const raw = '<sub_agent session_id="c" status="completed" turns="0" duration_ms="0">\n</sub_agent>'
    expect(parseSubAgentEnvelope(raw)?.body).toBe('')
  })
})
