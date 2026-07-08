import { describe, expect, it } from 'vitest'

import { applyMutation, applyMutations, describeMutation } from './harness.js'
import type { Harness } from './harness.js'

const TOOL = {
  name: 'write_file',
  description: 'write a file',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

function seed(): Harness {
  return {
    systemPrompt: 'You are an agent.',
    tools: [TOOL],
    extensions: { compactionHardThreshold: 0.92, hooksEnabled: false },
  }
}

describe('applyMutation', () => {
  it('set_system_prompt replaces the prompt', () => {
    const r = applyMutation(seed(), { kind: 'set_system_prompt', systemPrompt: 'new' })
    expect(r.ok && r.harness.systemPrompt).toBe('new')
  })

  it('append_system_prompt adds a newline-separated line', () => {
    const r = applyMutation(seed(), { kind: 'append_system_prompt', text: 'Always test.' })
    expect(r.ok && r.harness.systemPrompt).toBe('You are an agent.\nAlways test.')
  })

  it('append_system_prompt does not double a trailing newline', () => {
    const h: Harness = { ...seed(), systemPrompt: 'line\n' }
    const r = applyMutation(h, { kind: 'append_system_prompt', text: 'next' })
    expect(r.ok && r.harness.systemPrompt).toBe('line\nnext')
  })

  it('set_tool_description retunes an existing tool', () => {
    const r = applyMutation(seed(), {
      kind: 'set_tool_description',
      tool: 'write_file',
      description: 'Write UTF-8 text to a path. Creates parents.',
    })
    expect(r.ok && r.harness.tools[0]?.description).toBe(
      'Write UTF-8 text to a path. Creates parents.',
    )
  })

  it('set_tool_description rejects an unknown tool', () => {
    const r = applyMutation(seed(), {
      kind: 'set_tool_description',
      tool: 'nope',
      description: 'x',
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('unknown tool')
  })

  it('drop_tool removes it; add_tool restores it', () => {
    const dropped = applyMutation(seed(), { kind: 'drop_tool', tool: 'write_file' })
    expect(dropped.ok && dropped.harness.tools).toHaveLength(0)
    const readded = applyMutation(dropped.ok ? dropped.harness : seed(), {
      kind: 'add_tool',
      tool: TOOL,
    })
    expect(readded.ok && readded.harness.tools).toHaveLength(1)
  })

  it('add_tool rejects a duplicate', () => {
    const r = applyMutation(seed(), { kind: 'add_tool', tool: TOOL })
    expect(r.ok).toBe(false)
  })

  it('set_extension_knob validates compactionHardThreshold range', () => {
    const ok = applyMutation(seed(), {
      kind: 'set_extension_knob',
      knob: 'compactionHardThreshold',
      value: 0.8,
    })
    expect(ok.ok && ok.harness.extensions.compactionHardThreshold).toBe(0.8)

    const bad = applyMutation(seed(), {
      kind: 'set_extension_knob',
      knob: 'compactionHardThreshold',
      value: 2,
    })
    expect(bad.ok).toBe(false)
  })

  it('set_extension_knob type-checks hooksEnabled', () => {
    const ok = applyMutation(seed(), {
      kind: 'set_extension_knob',
      knob: 'hooksEnabled',
      value: true,
    })
    expect(ok.ok && ok.harness.extensions.hooksEnabled).toBe(true)

    const bad = applyMutation(seed(), {
      kind: 'set_extension_knob',
      knob: 'hooksEnabled',
      value: 3,
    })
    expect(bad.ok).toBe(false)
  })

  it('does not mutate its input', () => {
    const h = seed()
    const before = JSON.stringify(h)
    applyMutation(h, { kind: 'set_system_prompt', systemPrompt: 'changed' })
    expect(JSON.stringify(h)).toBe(before)
  })
})

describe('applyMutations', () => {
  it('applies a sequence in order', () => {
    const r = applyMutations(seed(), [
      { kind: 'append_system_prompt', text: 'a' },
      { kind: 'append_system_prompt', text: 'b' },
    ])
    expect(r.ok && r.harness.systemPrompt).toBe('You are an agent.\na\nb')
  })

  it('stops at the first failure', () => {
    const r = applyMutations(seed(), [
      { kind: 'append_system_prompt', text: 'a' },
      { kind: 'drop_tool', tool: 'missing' },
    ])
    expect(r.ok).toBe(false)
  })
})

describe('describeMutation', () => {
  it('produces a short label', () => {
    expect(describeMutation({ kind: 'drop_tool', tool: 'x' })).toBe('drop tool x')
  })
})
