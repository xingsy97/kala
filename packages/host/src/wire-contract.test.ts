/**
 * Wire-protocol contract tests.
 *
 * Three axes of coverage:
 *   1. Schema surface snapshot — the set of exported schema names is
 *      pinned. Removing or renaming a wire schema (a breaking change for
 *      any peer) trips this test and forces a review.
 *   2. Round-trip parses — representative payloads for the highest-traffic
 *      channels are validated via `.parse()`. Regressions where a schema
 *      stops accepting known-good data surface here.
 *   3. Rejection cases — payloads missing required fields, or with wrong
 *      shapes at the discriminator, must fail. This is the "safety net"
 *      for the trust boundary — parseWire() at the socket edge relies on
 *      these rejections to keep malformed data out of the loop.
 */
import { describe, expect, it } from 'vitest'
import { schema } from '@agent-kernel/shared'

describe('wire contract — schema surface', () => {
  it('exports a stable, sorted set of schema names', () => {
    const names = Object.keys(schema)
      .filter((k) => k.endsWith('Schema'))
      .sort()
    expect(names).toMatchSnapshot()
  })
})

describe('wire contract — round-trip parses', () => {
  it('parses ClientUserMessage (text-only)', () => {
    const out = schema.ClientUserMessageSchema.parse({
      sessionId: 's-1',
      text: 'hello',
    })
    expect(out.sessionId).toBe('s-1')
  })

  it('parses ClientUserMessage with structured content', () => {
    const out = schema.ClientUserMessageSchema.parse({
      sessionId: 's-1',
      text: 'see image',
      content: [
        { type: 'text', text: 'part' },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAA' } },
      ],
    })
    expect(out.content?.length).toBe(2)
  })

  it('parses ClientUserApprove / ClientUserReject', () => {
    expect(schema.ClientUserApproveSchema.parse({ sessionId: 's', callId: 'c' }))
      .toEqual({ sessionId: 's', callId: 'c' })
    expect(schema.ClientUserRejectSchema.parse({ sessionId: 's', callId: 'c', reason: 'nope' }))
      .toMatchObject({ reason: 'nope' })
  })

  it('parses ClientListSessions / ClientListExecutors from empty payloads', () => {
    expect(schema.ClientListSessionsSchema.parse(undefined)).toEqual({})
    expect(schema.ClientListSessionsSchema.parse({})).toEqual({})
    expect(schema.ClientListExecutorsSchema.parse(undefined)).toEqual({})
  })

  it('parses ClientSetApprovalMode across all four modes', () => {
    for (const mode of ['auto', 'ask', 'deny', 'allow_all'] as const) {
      expect(schema.ClientSetApprovalModeSchema.parse({ sessionId: 's', mode }))
        .toMatchObject({ mode })
    }
  })

  it('parses ExecutorAnnounce with workspaceId + workspaceName', () => {
    const out = schema.ExecutorAnnounceSchema.parse({
      executorId: 'ex-1',
      workspaceId: 'ws-1',
      workspaceName: 'demo',
      tools: ['read', 'write'],
      runtime: 'node',
      runtimeVersion: '22.0.0',
    })
    expect(out.workspaceId).toBe('ws-1')
  })

  it('parses ExecutorToolResult (ok)', () => {
    const out = schema.ExecutorToolResultSchema.parse({
      sessionId: 's-1',
      callId: 'c-1',
      ok: true,
      content: 'done',
    })
    expect(out.callId).toBe('c-1')
  })

  it('parses ClientCreateSession with and without cwd', () => {
    expect(schema.ClientCreateSessionSchema.parse({
      sessionId: 's', workspaceId: 'ws',
    })).toMatchObject({ sessionId: 's', workspaceId: 'ws' })

    expect(schema.ClientCreateSessionSchema.parse({
      sessionId: 's', workspaceId: 'ws', workspaceName: 'demo', cwd: '/tmp',
    })).toMatchObject({ cwd: '/tmp' })
  })

  it('parses ClientFork (minimum + full)', () => {
    expect(schema.ClientForkSchema.parse({
      sourceSessionId: 's', cursor: 42,
    })).toMatchObject({ cursor: 42 })
    expect(schema.ClientForkSchema.parse({
      sourceSessionId: 's', cursor: 0, newSessionId: 'n', seedMessage: 'hi',
    })).toMatchObject({ seedMessage: 'hi' })
  })

  it('parses ManualModelInput', () => {
    expect(schema.ManualModelInputSchema.parse({
      providerId: 'anthropic', id: 'claude-opus-4-7', label: 'Opus 4.7', contextWindow: 200000,
    })).toMatchObject({ id: 'claude-opus-4-7' })
  })

  it('parses ToolProgressPayload', () => {
    expect(schema.ToolProgressPayloadSchema.parse({
      sessionId: 's', callId: 'c', chunk: 'still working',
    })).toMatchObject({ chunk: 'still working' })
  })
})

describe('wire contract — rejection cases', () => {
  it('rejects ClientUserMessage missing required fields', () => {
    expect(schema.ClientUserMessageSchema.safeParse({ sessionId: 's' }).success).toBe(false)
    expect(schema.ClientUserMessageSchema.safeParse({ text: 'orphan' }).success).toBe(false)
  })

  it('rejects ClientSetApprovalMode with unknown mode', () => {
    expect(schema.ClientSetApprovalModeSchema.safeParse({
      sessionId: 's', mode: 'yolo',
    }).success).toBe(false)
  })

  it('rejects ExecutorAnnounce missing workspaceId', () => {
    // Regression: previously fixtures omitted workspaceId and slipped through.
    // The wire schema is authoritative — enforce it here so a future refactor
    // that "helpfully" makes workspaceId optional trips this test first.
    expect(schema.ExecutorAnnounceSchema.safeParse({
      executorId: 'ex-1',
      workspaceName: 'demo',
      tools: [],
      runtime: 'node',
      runtimeVersion: '22',
    }).success).toBe(false)
  })

  it('rejects ClientFork with negative cursor', () => {
    expect(schema.ClientForkSchema.safeParse({
      sourceSessionId: 's', cursor: -1,
    }).success).toBe(false)
  })

  it('rejects ManualModelInput with non-positive contextWindow', () => {
    expect(schema.ManualModelInputSchema.safeParse({
      providerId: 'p', id: 'm', contextWindow: 0,
    }).success).toBe(false)
  })

  it('rejects ClientListDirs missing requestId', () => {
    expect(schema.ClientListDirsSchema.safeParse({
      workspaceId: 'ws', path: '/x',
    }).success).toBe(false)
  })
})
