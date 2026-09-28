import { describe, expect, it } from 'vitest'
import { createBuiltinAgentModule, DEFAULT_CUSTOM_SYSTEM_PROMPT } from './builtin-tools.js'

const context = { mode: 'coding' as const, skills: [] }

describe('built-in assistant identity', () => {
  it('identifies the default assistant as Kala without renaming the Codex preset', () => {
    const module = createBuiltinAgentModule()
    const prompt = module.systemPrompt.render(context)

    expect(module.id).toBe('coding-agent-codex')
    expect(module.label).toBe('Codex Prompt')
    expect(prompt).toContain('You are Kala, an AI coding agent')
    expect(prompt).not.toContain('You are Codex')
  })

  it('asks both default prompts to avoid trivial delegation and hand off verified context', () => {
    for (const prompt of [createBuiltinAgentModule().systemPrompt.render(context), DEFAULT_CUSTOM_SYSTEM_PROMPT]) {
      expect(prompt).toContain('Do small lookups, single-file edits, and narrow tests yourself')
      expect(prompt).toContain('verified facts and relevant files, remaining questions, edit scope, verification, and expected output')
    }
  })

  it('uses the Kala identity in the editable custom prompt default', () => {
    expect(DEFAULT_CUSTOM_SYSTEM_PROMPT).toContain('You are Kala, an AI coding agent')
    expect(DEFAULT_CUSTOM_SYSTEM_PROMPT).not.toContain('You are Codex')
  })
})
