import { describe, expect, it } from 'vitest'

import { agentToolSchema } from './agent.js'

describe('agent tool schema', () => {
  it('tells the parent to send a structured self-contained child prompt', () => {
    const prompt = (agentToolSchema.inputSchema.properties as Record<string, { description?: string }>).prompt
    expect(prompt?.description).toContain('sent verbatim')
    expect(prompt?.description).toContain('self-contained')
    expect(prompt?.description).toContain('readable Markdown')
    expect(prompt?.description).toContain('blank lines')
    expect(prompt?.description).toContain('bullet points')
    expect(prompt?.description).toContain('dense paragraph')
  })
})
