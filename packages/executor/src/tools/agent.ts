import type { ToolSchema } from '@agent-kernel/kernel'

export const agentToolSchema: ToolSchema = {
  name: 'agent',
  description: 'Spawn a sub-agent to handle a focused sub-task.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      model: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
    },
    required: ['prompt'],
  },
  requiresApproval: false,
}
