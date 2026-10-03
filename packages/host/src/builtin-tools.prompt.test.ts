import { describe, expect, it } from 'vitest'
import { createBuiltinAgentModule, DEFAULT_KALA_SYSTEM_PROMPT, resolveBuiltinAgentModule } from './builtin-tools.js'

const context = { mode: 'coding' as const, skills: [] }

describe('built-in assistant identity', () => {
  it('uses brand-neutral Kala metadata and identity', () => {
    const module = createBuiltinAgentModule()
    const prompt = module.systemPrompt.render(context)

    expect(module.id).toBe('coding-agent-kala')
    expect(module.label).toBe('Kala Prompt')
    expect(prompt).toContain('You are Kala, an AI coding agent')
    expect(prompt).not.toContain('You are Codex')
    expect(prompt).not.toContain('You are Claude Code')
  })

  it('asks the default prompt to avoid trivial delegation and hand off verified context', () => {
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('Do small lookups, single-file edits, and narrow tests yourself')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('verified facts and relevant files, remaining questions, edit scope, verification, and expected output')
  })

  it('teaches the default prompt Dashboard-previewable paths', () => {
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('[README.md](./README.md)')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('[app.tsx](./src/app.tsx:12)')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('current session working directory')
  })

  it('renders the complete selected slot prompt without changing tools', () => {
    const selected = resolveBuiltinAgentModule({ systemPrompt: 'My own instructions.' })
    const defaults = resolveBuiltinAgentModule()

    expect(selected.systemPrompt).toBe('My own instructions.')
    expect(selected.tools).toEqual(defaults.tools)
  })

  it('distinguishes discussion from implementation and includes language guidance', () => {
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('For questions, explanations, reviews, or design discussions')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('For implementation tasks')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).toContain('Respond in the user’s current language')
    expect(DEFAULT_KALA_SYSTEM_PROMPT).not.toMatch(/token budget|time budget/i)
  })
})
