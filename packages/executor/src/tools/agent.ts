import type { ToolSchema } from '@agent-kernel/kernel'

export const agentToolSchema: ToolSchema = {
  name: 'agent',
  description: 'Spawn a sub-agent with fresh context to handle a focused sub-task. Make the prompt self-contained and use readable Markdown sections or bullet points for multi-part work.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, description: 'The complete, self-contained task sent verbatim to the child as its first user message. Include the objective, necessary context, constraints, and expected result. When the task contains multiple requirements, format it as readable Markdown with short sections, blank lines, and bullet points. Do not compress a multi-part task into one dense paragraph.' },
      model: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
    },
    required: ['prompt'],
  },
  requiresApproval: false,
}
