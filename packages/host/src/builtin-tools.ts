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
  customSystemPrompt?: string
} = {}) {
  return resolveAgentModule(createBuiltinAgentModule(input.systemPromptPreset, input.customSystemPrompt), {
    mode: 'coding',
    skills: input.skills ?? [],
    ...(input.contextLimit !== undefined ? { contextLimit: input.contextLimit } : {}),
  })
}

export type AgentSystemPromptPreset = 'codex' | 'claude-code' | 'custom'

export const TOOL_INTENTION_SYSTEM_INSTRUCTION = 'For every tool call, include the required _intent argument. It must be one natural-language sentence in the user’s current language that states the concrete user- or product-facing objective advanced by this specific call and why this step is needed. Never use a generic operation label such as “read file”, “search code”, or “run tests”; never paraphrase arguments or include commands, paths, parameters, secrets, or sensitive contents.'

export const AGENT_SYSTEM_PROMPT_PRESETS: readonly { id: AgentSystemPromptPreset; label: string; description: string }[] = [
  { id: 'codex', label: 'Codex', description: 'Direct coding-agent prompt with explicit execution and verification rules.' },
  { id: 'claude-code', label: 'Claude Code', description: 'Concise pair-programming prompt shaped for file edits, commands, and progress tracking.' },
  { id: 'custom', label: 'Custom', description: 'An editable system prompt for new sessions.' },
]

export function normalizeAgentSystemPromptPreset(value: unknown): AgentSystemPromptPreset {
  return value === 'claude-code' || value === 'custom' ? value : 'codex'
}

export function createBuiltinAgentModule(preset: AgentSystemPromptPreset = 'codex', customSystemPrompt = DEFAULT_CUSTOM_SYSTEM_PROMPT): AgentModule {
  const systemPrompt = preset === 'claude-code'
    ? claudeCodeSystemPromptPlugin
    : preset === 'custom'
      ? customSystemPromptPlugin(customSystemPrompt)
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
      TOOL_INTENTION_SYSTEM_INSTRUCTION,
      'Report concrete outcomes: what changed, what was verified, and what remains risky or untested.',
    ].join('\n\n')
  },
}

export const DEFAULT_CUSTOM_SYSTEM_PROMPT = [
  'You are Codex, a coding agent running inside Agent RunLab in a shared developer workspace.',
  'Work pragmatically: inspect the codebase before changing it, make focused edits, and verify the result with the narrowest reliable tests.',
  'Prefer existing project patterns over new abstractions. Use fast search tools first, especially ripgrep-backed search, before broad file reads.',
  'Treat filesystem, shell, network, and memory tools as real side effects. Avoid destructive actions unless the user clearly requested them or approval policy permits them.',
  'When editing, keep unrelated files and user changes intact. Do not revert work you did not make.',
  'If the user asks you to modify files, run commands, or continue unfinished work, either ask a necessary clarification, explain a real blocker, or continue by using tools. Do not claim that you changed, ran, verified, or completed something unless a tool result confirms it.',
  'For multi-step work, keep a concise task list and update it as the state changes. Mark work complete only after verification.',
  TOOL_INTENTION_SYSTEM_INSTRUCTION,
  'Report concrete outcomes: what changed, what was verified, and what remains risky or untested.',
  'When referencing a file, use a Markdown link such as [filename](path/to/this/file).',
].join('\n\n')

function customSystemPromptPlugin(prompt: string): SystemPromptPlugin {
  return {
    id: 'custom-system-prompt',
    version: '2026-07-15',
    label: 'Custom System Prompt',
    render: () => prompt,
  }
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
      TOOL_INTENTION_SYSTEM_INSTRUCTION,
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
      tool('read_file', 'executor', 'read', false, 'read_file', {
        purpose: 'Read one UTF-8 text file. Returns batcat-style line-numbered output plus a content revision for safe follow-up edits.',
        whenToUse: ['Inspect one source file, config, log, or doc before making decisions.', 'Read targeted ranges when the file is large.'],
        constraints: ['Use absolute paths.', 'Do not read secrets unless required for the user task.'],
      }, {
        type: 'object', required: ['path'], properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          offset: { type: 'integer', minimum: 0, description: '0-indexed line to start from.' },
          limit: { type: 'integer', minimum: 1, description: 'Maximum lines to return.' },
        },
      }),
      tool('read_files', 'executor', 'read', false, 'read_files', {
        purpose: 'Read multiple UTF-8 text files in one call. Returns batcat-style sections with file headers and line numbers.',
        whenToUse: ['Inspect related implementation, interface, and test files together.', 'Reduce repeated file-read tool calls when the exact files are already known.'],
        constraints: ['Use absolute paths.', 'Keep the file list focused; use search_files or find_files before broad reads.'],
      }, {
        type: 'object', required: ['files'], properties: {
          files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } } } },
          max_bytes: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Maximum combined output bytes.' },
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
      tool('multi_grep', 'executor', 'read', false, 'multi_grep', {
        purpose: 'Run multiple bounded regex searches in one ordered Tool call.',
        whenToUse: ['Investigate several related symbols or failure signatures together.', 'Reduce repeated grep calls while preserving per-search output sections.'],
        constraints: ['Keep each search scoped where possible.', 'Use at most 20 searches; output is bounded by max_bytes.'],
      }, { type: 'object', required: ['searches'], properties: { searches: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, case_insensitive: { type: 'boolean' } } } }, max_bytes: { type: 'integer', minimum: 1, maximum: 1000000 } } }),
      tool('write_file', 'executor', 'write', true, 'write_file', {
        purpose: 'Create or fully overwrite one UTF-8 text file, creating parent directories as needed.',
        whenToUse: ['Create new files or fully replace generated files.'],
        constraints: ['Avoid overwriting user changes unintentionally.', 'Prefer replace_in_file or replace_many_in_file for focused source changes.'],
      }, { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } }),
      tool('replace_in_file', 'executor', 'write', true, 'replace_in_file', {
        purpose: 'Replace one exact string in one text file. Fails if old_string is missing or ambiguous unless replace_all is true.',
        whenToUse: ['Apply one focused source edit when exact context is known.', 'Preserve surrounding file content exactly.'],
        constraints: ['Read the target context first.', 'Do not include line numbers in old_string.', 'Use replace_all only when every occurrence should change.'],
      }, { type: 'object', required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' }, expected_revision: { type: 'string', description: 'Optional sha256 revision returned by read_file.' }, no_op_mode: { type: 'string', enum: ['strict', 'skip_noop'] } } }),
      tool('replace_many_in_file', 'executor', 'write', true, 'replace_many_in_file', {
        purpose: 'Apply multiple exact string replacements to one text file in order, then commit once only if every replacement succeeds.',
        whenToUse: ['Make several coordinated edits in the same file.', 'Avoid multiple separate replace_in_file calls on one file.'],
        constraints: ['Read the target context first.', 'Each old_string must match the current file content at its step.', 'Use apply_file_patch for complex line-level changes.'],
      }, { type: 'object', required: ['path', 'edits'], properties: { path: { type: 'string' }, expected_revision: { type: 'string', description: 'Optional sha256 revision returned by read_file.' }, no_op_mode: { type: 'string', enum: ['strict', 'skip_noop'] }, edits: { type: 'array', minItems: 1, items: { type: 'object', required: ['old_string', 'new_string'], properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } } } } } }),
      tool('apply_file_patch', 'executor', 'write', true, 'apply_file_patch', {
        purpose: 'Apply a patch-format file mutation. Supports add, update, delete, and move operations; a patch may touch one file or many files.',
        whenToUse: ['Apply complex line-level changes.', 'Create, delete, move, or update files from one patch-format description.'],
        constraints: ['Patch context must match exactly.', 'Prefer replace_in_file for one small exact replacement.', 'Use the Agent RunLab patch format beginning with *** Begin Patch and ending with *** End Patch.'],
      }, { type: 'object', required: ['patch'], properties: { patch: { type: 'string', description: 'Patch text beginning with *** Begin Patch and ending with *** End Patch.' } } }),
    ]
  },
}

const shellToolset: ToolsetPlugin = {
  id: 'shell',
  version: '2026-07-15',
  label: 'Shell',
  provideTools() {
    return [
      tool('shell', 'executor', 'shell', true, 'bash', {
        purpose: 'Run a native shell command inside the executor sandbox. Uses PowerShell or cmd on Windows and a POSIX shell on macOS/Linux.',
        whenToUse: ['Run tests, builds, linters, package scripts, or precise shell inspections.', 'Use background mode for long-running commands.'],
        constraints: ['Use syntax for the selected Workspace operating system.', 'Avoid destructive commands unless explicitly requested.', 'Set timeout_seconds to the expected command duration for foreground commands.', 'Use run_in_background for long-running commands, servers, experiments, or commands that need polling.'],
      }, { type: 'object', required: ['command'], properties: { command: { type: 'string' }, shell: { type: 'string', enum: ['auto', 'powershell', 'cmd', 'bash', 'zsh', 'sh'] }, cwd: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, description: 'Maximum foreground command runtime in seconds. Pick a value appropriate to the command.' }, run_in_background: { type: 'boolean' } } }),
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
    return [
      tool('todowrite', 'executor', 'read', false, 'todowrite', {
        purpose: 'Create and maintain a simple linear task list for the current session. The input replaces the entire list.',
        whenToUse: ['Use for straightforward multi-step work without dependencies.', 'Use when the user asks for a simple todo list.'],
        constraints: ['Use todo_graph instead when tasks have prerequisites or parallel branches.', 'Always include every todo that should remain.', 'Exactly one item may be in_progress at a time.', 'Mark completed only after verification.'],
      }, { type: 'object', required: ['todos'], properties: { todos: { type: 'array', description: 'The complete replacement list of todos.', items: { type: 'object', required: ['content', 'status'], properties: { content: { type: 'string', description: 'Short imperative description of the task.' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }, priority: { type: 'string', enum: ['high', 'medium', 'low'] } } } } } }),
      tool('todo_graph', 'host', 'read', false, 'todo_graph', {
        purpose: 'Create and maintain a session task dependency graph with parallel branches and blocked work. Operations are atomic.',
        whenToUse: ['Use when tasks have prerequisites, fan-out/fan-in, blocked work, or parallel execution.', 'Use for complex implementation plans that cannot be represented accurately as a linear list.'],
        constraints: ['Use stable semantic node IDs.', 'Add only real dependencies; do not turn ordering preferences into edges.', 'Blocked nodes cannot be in_progress, but multiple unblocked nodes may be in_progress.', 'Prefer incremental operations after initial replace.', 'Mark completed only after verification.'],
      }, todoGraphSchema),
    ]
  },
}

const agentToolset: ToolsetPlugin = {
  id: 'subagents',
  version: '2026-07-15',
  label: 'Sub-agents',
  provideTools() {
    return [tool('agent', 'host', 'agent', false, 'agent', {
      purpose: 'Spawn a sub-agent to handle a focused sub-task.',
      whenToUse: ['Delegate bounded investigation, testing, or review.', 'Use when parallel or isolated work would reduce context pressure.'],
      constraints: ['Give a specific objective and expected output.', 'Do not use for trivial single-step tasks.'],
    }, { type: 'object', properties: { prompt: { type: 'string' }, model: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } }, role: { type: 'string', enum: ['research', 'test', 'review'], description: 'Optional role template. Selects long-running defaults for allowed tools, turns, idle/tool-idle deadlines, absolute deadline, grace, and expected output. Omit timeout_ms for normal work.' }, objective: { type: 'string' }, max_turns: { type: 'integer', minimum: 1 }, timeout_ms: { type: 'integer', minimum: 1 }, expected_output: { type: 'string' } }, required: ['prompt'] })]
  },
}

const webToolset: ToolsetPlugin = {
  id: 'web',
  version: '2026-07-15',
  label: 'Web',
  provideTools() {
    return [
      tool('websearch', 'host', 'network', false, 'websearch', {
        purpose: 'Search the web and return top results as text.',
        whenToUse: ['Look up current information, documentation, error messages, or facts not in the conversation.'],
        constraints: ['Prefer official or primary sources when possible.', 'Do not use web search for facts already available in the workspace.'],
      }, { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'The search query.' }, limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum results to return.' } } }),
      tool('webfetch', 'executor', 'network', false, 'webfetch', {
        purpose: 'Fetch a web page by URL and return readable text extracted from HTML or plain text.',
        whenToUse: ['Open a promising search result or official source.', 'Inspect source pages while answering web research questions.'],
        constraints: ['Use absolute http(s) URLs.', 'Prefer primary sources and cite the page used when the task asks for evidence.'],
      }, { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'Absolute http(s) URL to fetch.' }, maxChars: { type: 'integer', minimum: 1, maximum: 50000, description: 'Maximum characters of extracted page text to return.' } } }),
    ]
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

const todoGraphNodeSchema = {
  type: 'object', required: ['id', 'content', 'status'], additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
    content: { type: 'string', minLength: 1, maxLength: 500 },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}
const todoGraphEdgeSchema = {
  type: 'object', required: ['from', 'to'], additionalProperties: false,
  properties: { from: { type: 'string' }, to: { type: 'string' } },
}
const todoGraphSchema = {
  type: 'object', required: ['operations'], additionalProperties: false,
  properties: {
    expectedRevision: { type: 'integer', minimum: 0 },
    operations: {
      type: 'array', minItems: 1, maxItems: 100,
      items: {
        type: 'object', required: ['op'],
        properties: {
          op: { type: 'string', enum: ['replace', 'add_node', 'update_node', 'remove_node', 'add_edge', 'remove_edge', 'clear'] },
          nodes: { type: 'array', items: todoGraphNodeSchema }, edges: { type: 'array', items: todoGraphEdgeSchema },
          node: todoGraphNodeSchema, id: { type: 'string' }, content: { type: 'string', minLength: 1, maxLength: 500 },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          priority: { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] },
          from: { type: 'string' }, to: { type: 'string' }, cascade: { type: 'boolean' },
        },
      },
    },
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
