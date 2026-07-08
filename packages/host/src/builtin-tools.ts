/**
 * Built-in ToolSchema list matching the tools shipped in
 * `@agent-kernel/executor`. The host declares these to the LLM so tool_calls
 * are well-formed; the executor is what actually runs each tool.
 *
 * `agent-kernel-host` uses this by default. Callers embedding `startHostServer`
 * directly can pass their own tools list via `defaultConfig.tools`.
 */

import type { ToolSchema } from '@agent-kernel/kernel'

import { skillToolSchema } from './extensions/skills.js'
import type { SkillInfo } from './extensions/skills.js'

export function createBuiltinTools(
  skills: readonly SkillInfo[] = [],
): readonly ToolSchema[] {
  return [skillToolSchema(skills), ...executorAndHostTools]
}

const executorAndHostTools: readonly ToolSchema[] = [
  {
    name: 'read',
    description:
      'Read a UTF-8 text file. Returns cat -n style output with tab-separated line numbers.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        offset: {
          type: 'integer',
          minimum: 0,
          description: '0-indexed line to start from.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum lines to return.',
        },
      },
    },
    requiresApproval: false,
  },
  {
    name: 'ls',
    description:
      'List directory entries. Directories get a trailing "/". Hidden entries excluded unless `hidden: true`.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        hidden: { type: 'boolean' },
      },
    },
    requiresApproval: false,
  },
  {
    name: 'glob',
    description:
      'Find files matching a glob pattern (picomatch). Results sorted by mtime desc.',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
    },
    requiresApproval: false,
  },
  {
    name: 'grep',
    description:
      'Ripgrep-like regex search. `output_mode` = "content" | "files_with_matches" | "count".',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string', description: 'Filter files by glob.' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
        },
        case_insensitive: { type: 'boolean' },
      },
    },
    requiresApproval: false,
  },
  {
    name: 'write',
    description:
      'Write UTF-8 content to a file, creating parent directories as needed.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
    },
    requiresApproval: true,
  },
  {
    name: 'edit',
    description:
      'Exact string replacement. Fails if `old_string` is missing or ambiguous (unless `replace_all: true`).',
    inputSchema: {
      type: 'object',
      required: ['path', 'old_string', 'new_string'],
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
    },
    requiresApproval: true,
  },
  {
    name: 'bash',
    description:
      'Run a bash command inside the executor sandbox. Captures stdout+stderr up to 1MB.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1 },
        run_in_background: { type: 'boolean' },
      },
    },
    requiresApproval: true,
  },
  {
    name: 'bash_output',
    description: 'Read output from a background bash task by task_id.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        block: { type: 'boolean' },
        timeout_ms: { type: 'integer', minimum: 1 },
      },
    },
    requiresApproval: false,
  },
  {
    name: 'kill_shell',
    description: 'Stop a background bash task by task_id.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
      },
    },
    requiresApproval: true,
  },
  {
    name: 'todowrite',
    description:
      'Create and maintain a structured task list for the current session. Use for multi-step work (three or more steps), or whenever the user asks for a todo list. The input REPLACES the entire list — always include every todo you want to keep, not just the ones changing. Exactly one item may be in_progress at a time; mark items completed only after the work is verified.',
    inputSchema: {
      type: 'object',
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          description: 'The complete replacement list of todos.',
          items: {
            type: 'object',
            required: ['content', 'status'],
            properties: {
              content: {
                type: 'string',
                description: 'Short imperative description of the task.',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
              },
              priority: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
              },
            },
          },
        },
      },
    },
    requiresApproval: false,
  },
  {
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
  },
  {
    name: 'websearch',
    description:
      'Search the web via DuckDuckGo and return the top results as text. Use for looking up current information, documentation, error messages, or facts not in the conversation. Returns a numbered list of `{title, url, snippet}` entries. `limit` defaults to 5 and is capped at 10.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'Maximum results to return (default 5, max 10).',
        },
      },
    },
    requiresApproval: false,
  },
  {
    name: 'memory',
    description:
      'Read, list, write, or delete the agent\'s persistent notepad. Use operation=`list` to list keys, `read` to fetch one entry, `write` to upsert, and `delete` to remove. Scopes: `session` (in AgentState, forkable), `workspace` (on disk in this workspace), `global` (on disk for this machine).',
    inputSchema: {
      type: 'object',
      required: ['operation', 'scope'],
      properties: {
        operation: { type: 'string', enum: ['list', 'read', 'write', 'delete'] },
        scope: { type: 'string', enum: ['session', 'workspace', 'global'] },
        key: {
          type: 'string',
          description: 'Required for read/write/delete. Pattern: ^[a-zA-Z0-9_-]{1,64}$.',
        },
        content: {
          type: 'string',
          description: 'Required for write. Text/markdown content, capped at 128 KB per entry.',
        },
        updatedAt: {
          type: 'string',
          description:
            'ISO-8601 timestamp for session-scope writes. The kernel uses this when lifting memory into AgentState.',
        },
      },
    },
    requiresApproval: false,
  },
]

export const builtinTools: readonly ToolSchema[] = createBuiltinTools()
