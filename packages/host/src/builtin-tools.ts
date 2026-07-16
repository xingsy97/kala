/**
 * Built-in agent module and toolsets shipped with the host runtime.
 *
 * The kernel still consumes plain ToolSchema objects. The host owns the richer
 * ToolsetPlugin layer: tool prompt, policy, execution kind, and provenance are
 * rendered into ToolSchema at session/config assembly time.
 */

import type { ToolSchema } from '@agent-kernel/kernel'

import { skillToolSchema, type SkillInfo } from './extensions/skills.js'
import { resolveAgentModule } from './agent-modules/renderers.js'
import type { AgentModule, SystemPromptPlugin, ToolDefinition, ToolsetPlugin } from './agent-modules/types.js'

export function createBuiltinTools(
  skills: readonly SkillInfo[] = [],
): readonly ToolSchema[] {
  return resolveBuiltinAgentModule({ skills }).tools
}

export function resolveBuiltinAgentModule(input: {
  skills?: readonly SkillInfo[]
  contextLimit?: number
  systemPromptPreset?: AgentSystemPromptPreset
} = {}) {
  return resolveAgentModule(createBuiltinAgentModule(input.systemPromptPreset), {
    mode: 'coding',
    skills: input.skills ?? [],
    ...(input.contextLimit !== undefined ? { contextLimit: input.contextLimit } : {}),
  })
}

export type AgentSystemPromptPreset = 'codex' | 'claude-code'

export const AGENT_SYSTEM_PROMPT_PRESETS: readonly { id: AgentSystemPromptPreset; label: string; description: string }[] = [
  { id: 'codex', label: 'Codex', description: 'Direct coding-agent prompt with explicit execution and verification rules.' },
  { id: 'claude-code', label: 'Claude Code', description: 'Concise pair-programming prompt shaped for file edits, commands, and progress tracking.' },
]

export function normalizeAgentSystemPromptPreset(value: unknown): AgentSystemPromptPreset {
  return value === 'claude-code' ? 'claude-code' : 'codex'
}

export function createBuiltinAgentModule(preset: AgentSystemPromptPreset = 'codex'): AgentModule {
  const systemPrompt = preset === 'claude-code'
    ? claudeCodeSystemPromptPlugin
    : codexSystemPromptPlugin
  return {
    id: `coding-agent-${preset}`,
    version: '2026-07-15',
    label: preset === 'claude-code' ? 'Claude Code Prompt' : 'Codex Prompt',
    systemPrompt,
    toolsets: [skillToolset, filesystemToolset, shellToolset, planningToolset, agentToolset, webToolset, memoryToolset],
  }
}

const codexSystemPromptPlugin: SystemPromptPlugin = {
  id: 'codex-system-prompt',
  version: '2026-07-15',
  label: 'Codex System Prompt',
  render() {
    return [
      'You are Codex, a coding agent running inside Agent RunLab in a shared developer workspace.',
      'Work pragmatically: inspect the codebase before changing it, make focused edits, and verify the result with the narrowest reliable tests.',
      'Prefer existing project patterns over new abstractions. Use fast search tools first, especially ripgrep-backed search, before broad file reads.',
      'Treat filesystem, shell, network, and memory tools as real side effects. Avoid destructive actions unless the user clearly requested them or approval policy permits them.',
      'When editing, keep unrelated files and user changes intact. Do not revert work you did not make.',
      'If the user asks you to modify files, run commands, or continue unfinished work, either ask a necessary clarification, explain a real blocker, or continue by using tools. Do not claim that you changed, ran, verified, or completed something unless a tool result confirms it.',
      'For multi-step work, keep a concise task list and update it as the state changes. Mark work complete only after verification.',
      'Report concrete outcomes: what changed, what was verified, and what remains risky or untested.',
    ].join('\n\n')
  },
}

const claudeCodeSystemPromptPlugin: SystemPromptPlugin = {
  id: 'claude-code-system-prompt',
  version: '2026-07-15',
  label: 'Claude Code System Prompt',
  render() {
    return [
      'You are Claude Code, an interactive coding agent running inside Agent RunLab.',
      'Help the user with software engineering tasks in the current workspace. Be direct, concise, and action-oriented.',
      'Before making changes, understand the relevant files and existing conventions. Prefer precise reads and searches over broad exploration.',
      'When the user requests an implementation, move the work forward with file and shell tools once the task is clear. It is acceptable to clarify or report a real blocker first, but do not only describe future work when you can act.',
      'If you say you added, updated, fixed, removed, ran, or verified something, that statement must be backed by a tool call result in the current turn.',
      'Respect existing user changes. Never revert unrelated work. Avoid destructive shell commands unless the user explicitly requests them.',
      'Use todo tracking for multi-step work. Keep exactly one active task and mark tasks complete only after the corresponding work is actually done.',
      'Finish with a short report of changed files, verification, and any remaining risks.',
    ].join('\n\n')
  },
}

const skillToolset: ToolsetPlugin = {
  id: 'skills',
  version: '2026-07-15',
  label: 'Skills',
  provideTools(ctx) {
    const schema = skillToolSchema(ctx.skills)
    return [{
      name: schema.name,
      inputSchema: schema.inputSchema,
      requiresApproval: schema.requiresApproval,
      prompt: {
        purpose: schema.description,
        whenToUse: ['Use when a named skill can provide domain-specific instructions for the current task.'],
        constraints: ['Only invoke skills that are relevant to the user request.', 'Follow the loaded skill instructions before acting.'],
      },
      policy: { risk: 'read', approvalDefault: 'auto' },
      execution: { kind: 'host', handler: schema.name },
    }]
  },
}

const filesystemToolset: ToolsetPlugin = {
  id: 'filesystem',
  version: '2026-07-15',
  label: 'Filesystem',
  provideTools() {
    return [
      tool('read', 'executor', 'read', false, 'read', {
        purpose: 'Read a UTF-8 text file. Returns cat -n style output with tab-separated line numbers.',
        whenToUse: ['Inspect source files, configs, logs, or docs before making decisions.', 'Read targeted ranges when the file is large.'],
        constraints: ['Use absolute paths.', 'Do not read secrets unless required for the user task.'],
      }, {
        type: 'object', required: ['path'], properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          offset: { type: 'integer', minimum: 0, description: '0-indexed line to start from.' },
          limit: { type: 'integer', minimum: 1, description: 'Maximum lines to return.' },
        },
      }),
      tool('ls', 'executor', 'read', false, 'ls', {
        purpose: 'List directory entries. Directories get a trailing slash. Hidden entries excluded unless hidden is true.',
        whenToUse: ['Explore an unfamiliar directory.', 'Confirm paths before reading or editing files.'],
        constraints: ['Prefer targeted listing over recursively dumping large trees.'],
      }, { type: 'object', required: ['path'], properties: { path: { type: 'string' }, hidden: { type: 'boolean' } } }),
      tool('glob', 'executor', 'read', false, 'glob', {
        purpose: 'Find files matching a glob pattern. Results are sorted by mtime descending.',
        whenToUse: ['Locate files by name or extension.', 'Find likely implementation or test files.'],
        constraints: ['Prefer precise patterns to broad workspace scans.'],
      }, { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' } } }),
      tool('grep', 'executor', 'read', false, 'grep', {
        purpose: 'Ripgrep-like regex search with content, files_with_matches, or count output modes.',
        whenToUse: ['Search code symbols, error strings, config keys, or behavior references.', 'Use before reading many files.'],
        constraints: ['Scope by path or glob when possible.', 'Use case_insensitive only when needed.'],
      }, { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string', description: 'Filter files by glob.' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, case_insensitive: { type: 'boolean' } } }),
      tool('write', 'executor', 'write', true, 'write', {
        purpose: 'Write UTF-8 content to a file, creating parent directories as needed.',
        whenToUse: ['Create new files or fully replace generated files.'],
        constraints: ['Avoid overwriting user changes unintentionally.', 'Prefer edit for small source changes.'],
      }, { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } }),
      tool('edit', 'executor', 'write', true, 'edit', {
        purpose: 'Exact string replacement. Fails if old_string is missing or ambiguous unless replace_all is true.',
        whenToUse: ['Apply focused source edits.', 'Preserve surrounding file content exactly.'],
        constraints: ['Read the target context first.', 'Use replace_all only when every occurrence should change.'],
      }, { type: 'object', required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } } }),
    ]
  },
}

const shellToolset: ToolsetPlugin = {
  id: 'shell',
  version: '2026-07-15',
  label: 'Shell',
  provideTools() {
    return [
      tool('bash', 'executor', 'shell', true, 'bash', {
        purpose: 'Run a bash command inside the executor sandbox. Captures stdout and stderr up to 1MB.',
        whenToUse: ['Run tests, builds, linters, package scripts, or precise shell inspections.', 'Use background mode for long-running commands.'],
        constraints: ['Avoid destructive commands unless explicitly requested.', 'Set timeout_seconds to the expected command duration for foreground commands.', 'Use run_in_background for long-running commands, servers, experiments, or commands that need polling.'],
      }, { type: 'object', required: ['command'], properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, description: 'Maximum foreground command runtime in seconds. Pick a value appropriate to the command.' }, run_in_background: { type: 'boolean' } } }),
      tool('bash_output', 'executor', 'shell', false, 'bash_output', {
        purpose: 'Read output from a background bash task by task_id.',
        whenToUse: ['Poll long-running tests, builds, dev servers, or experiments.'],
        constraints: ['Poll frequently enough to avoid wasting time.', 'Use offsets to avoid rereading huge output.'],
      }, { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, block: { type: 'boolean' }, timeout_ms: { type: 'integer', minimum: 1 } } }),
      tool('kill_shell', 'executor', 'shell', true, 'kill_shell', {
        purpose: 'Stop a background bash task by task_id.',
        whenToUse: ['Terminate a known long-running task that is no longer needed.'],
        constraints: ['Only kill the specific task_id you intend to stop.'],
      }, { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } }),
    ]
  },
}

const planningToolset: ToolsetPlugin = {
  id: 'planning',
  version: '2026-07-15',
  label: 'Planning',
  provideTools() {
    return [tool('todowrite', 'executor', 'read', false, 'todowrite', {
      purpose: 'Create and maintain a structured task list for the current session. The input replaces the entire list.',
      whenToUse: ['Use for multi-step work, usually three or more steps.', 'Use when the user asks for a todo list or progress tracking.'],
      constraints: ['Always include every todo that should remain.', 'Exactly one item may be in_progress at a time.', 'Mark completed only after verification.'],
    }, { type: 'object', required: ['todos'], properties: { todos: { type: 'array', description: 'The complete replacement list of todos.', items: { type: 'object', required: ['content', 'status'], properties: { content: { type: 'string', description: 'Short imperative description of the task.' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }, priority: { type: 'string', enum: ['high', 'medium', 'low'] } } } } } })]
  },
}

const agentToolset: ToolsetPlugin = {
  id: 'subagents',
  version: '2026-07-15',
  label: 'Sub-agents',
  provideTools() {
    return [tool('agent', 'host', 'agent', false, 'agent', {
      purpose: 'Spawn a sub-agent to handle a focused sub-task.',
      whenToUse: ['Delegate bounded investigation, testing, review, or benchmark triage.', 'Use when parallel or isolated work would reduce context pressure.'],
      constraints: ['Give a specific objective and expected output.', 'Do not use for trivial single-step tasks.'],
    }, { type: 'object', properties: { prompt: { type: 'string' }, model: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } }, role: { type: 'string', enum: ['research', 'test', 'review', 'benchmark-triage'], description: 'Optional role template. Selects default allowed tools, max turns, timeout, and expected output.' }, objective: { type: 'string' }, max_turns: { type: 'integer', minimum: 1 }, timeout_ms: { type: 'integer', minimum: 1 }, expected_output: { type: 'string' } }, required: ['prompt'] })]
  },
}

const webToolset: ToolsetPlugin = {
  id: 'web',
  version: '2026-07-15',
  label: 'Web',
  provideTools() {
    return [tool('websearch', 'executor', 'network', false, 'websearch', {
      purpose: 'Search the web and return top results as text.',
      whenToUse: ['Look up current information, documentation, error messages, or facts not in the conversation.'],
      constraints: ['Prefer official or primary sources when possible.', 'Do not use web search for facts already available in the workspace.'],
    }, { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'The search query.' }, limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum results to return.' } } })]
  },
}

const memoryToolset: ToolsetPlugin = {
  id: 'memory',
  version: '2026-07-15',
  label: 'Memory',
  provideTools() {
    return [tool('memory', 'executor', 'memory', false, 'memory', {
      purpose: 'Read, list, write, or delete the agent persistent notepad.',
      whenToUse: ['Use durable workspace/global memory for stable user or project preferences.', 'Use session memory for notes that should fork with the session.'],
      constraints: ['Do not store secrets.', 'Write concise, durable facts rather than raw transcripts.'],
    }, { type: 'object', required: ['operation', 'scope'], properties: { operation: { type: 'string', enum: ['list', 'read', 'write', 'delete'] }, scope: { type: 'string', enum: ['session', 'workspace', 'global'] }, key: { type: 'string', description: 'Required for read/write/delete. Pattern: ^[a-zA-Z0-9_-]{1,64}$.' }, content: { type: 'string', description: 'Required for write. Text/markdown content, capped at 128 KB per entry.' }, updatedAt: { type: 'string', description: 'ISO-8601 timestamp for session-scope writes.' } } })]
  },
}

function tool(
  name: string,
  executionKind: 'host' | 'executor',
  risk: ToolDefinition['policy']['risk'],
  requiresApproval: boolean,
  handler: string,
  prompt: ToolDefinition['prompt'],
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    inputSchema,
    requiresApproval,
    prompt,
    policy: { risk, approvalDefault: requiresApproval ? 'ask' : 'auto' },
    execution: { kind: executionKind, handler },
  }
}

export const builtinTools: readonly ToolSchema[] = createBuiltinTools()
