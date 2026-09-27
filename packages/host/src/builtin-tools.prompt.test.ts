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

  it('uses the Kala identity in the editable custom prompt default', () => {
    expect(DEFAULT_CUSTOM_SYSTEM_PROMPT).toContain('You are Kala, an AI coding agent')
    expect(DEFAULT_CUSTOM_SYSTEM_PROMPT).not.toContain('You are Codex')
  })
})
