import { describe, expect, it } from 'vitest'

import { schema } from './index.js'

const base = { workspaceId: 'ws', sessionId: 'session' }

describe('terminal wire schemas', () => {
  it('bounds terminal dimensions, input, cwd, and output replay chunks', () => {
    expect(schema.ClientTerminalCreateSchema.safeParse({ ...base, requestId: 'r', cols: 500, rows: 500, cwd: 'x'.repeat(4096) }).success).toBe(true)
    expect(schema.ClientTerminalCreateSchema.safeParse({ ...base, requestId: 'r', cols: 501 }).success).toBe(false)
    expect(schema.ClientTerminalResizeSchema.safeParse({ ...base, terminalId: 't', cols: 80, rows: 501 }).success).toBe(false)
    expect(schema.ClientTerminalInputSchema.safeParse({ ...base, terminalId: 't', data: 'x'.repeat(65_536) }).success).toBe(true)
    expect(schema.ClientTerminalInputSchema.safeParse({ ...base, terminalId: 't', data: 'x'.repeat(65_537) }).success).toBe(false)
    expect(schema.ClientTerminalCreateSchema.safeParse({ ...base, requestId: 'r', cwd: 'x'.repeat(4097) }).success).toBe(false)
    expect(schema.ServerTerminalOutputSchema.safeParse({ ...base, terminalId: 't', data: 'x'.repeat(1_048_577) }).success).toBe(false)
  })
})
