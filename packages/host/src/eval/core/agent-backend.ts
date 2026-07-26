import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { AgentBackendDescriptor, AgentBackendId } from '@agent-kernel/shared'

const HOST_ROOT = resolveHostSourceRoot()
const RELEASE_ROOT = resolve(process.env.AGENT_RUNLAB_RELEASE_ROOT?.trim() || (process.argv[1] ? join(resolve(process.argv[1]), '..') : process.cwd()))

export type AgentBackendExecutionConfig = {
  id: AgentBackendId
  model: string
  config: Record<string, unknown>
}

export type AgentBackendValidation = {
  ok: boolean
  errors: readonly string[]
  warnings: readonly string[]
}

export interface AgentBackend {
  readonly descriptor: AgentBackendDescriptor
  validate(config: AgentBackendExecutionConfig): AgentBackendValidation
  command(config: AgentBackendExecutionConfig): string
}

function resolveHostSourceRoot(): string {
  const configured = process.env.AGENT_RUNLAB_HOST_SOURCE_ROOT?.trim()
  if (configured) return resolve(configured)
  const candidates = [resolve(process.cwd(), 'packages', 'host'), resolve(process.cwd())]
  return candidates.find((candidate) => existsSync(join(candidate, 'bin'))) ?? candidates[0]!
}

const productionCapabilities = {
  realAgent: true,
  sessionLog: true,
  trace: true,
  cancellation: true,
  configurableModel: true,
  configurableTools: true,
  resume: false,
} as const

const agentRunLab: AgentBackend = {
  descriptor: {
    id: 'agent-runlab',
    label: 'Agent RunLab',
    description: 'Run the real Agent RunLab Host loop and executor tools in an isolated SWE-bench workspace.',
    evidenceLevel: 'predictions_only',
    production: true,
    available: existsSync(join(HOST_ROOT, 'bin', 'run-agent-runlab-swebench.ts')) || existsSync(join(RELEASE_ROOT, 'agent-runlab-swebench-runner.cjs')),
    capabilities: productionCapabilities,
    configFields: [
      { key: 'maxTurns', label: 'Maximum turns', kind: 'number', required: false, defaultValue: 40 },
      { key: 'systemPromptPreset', label: 'System prompt preset', kind: 'enum', required: false, defaultValue: 'codex', options: ['codex', 'claude-code'] },
    ],
  },
  validate(config) {
    return validateModelAndPositive(config, ['maxTurns'])
  },
  command(config) {
    const maxTurns = positive(config.config.maxTurns) ?? 40
    const preset = config.config.systemPromptPreset === 'claude-code' ? 'claude-code' : 'codex'
    const packaged = join(RELEASE_ROOT, 'agent-runlab-swebench-runner.cjs')
    if (existsSync(packaged)) return command([process.execPath, packaged, '--prompt-file', '$AGENT_KERNEL_SWEBENCH_PROMPT_FILE', '--repo', '$AGENT_KERNEL_SWEBENCH_REPO', '--session-log', '$AGENT_KERNEL_SWEBENCH_SESSION_LOG', '--sessions-dir', '$AGENT_KERNEL_SWEBENCH_REPO/.agent-runlab-sessions', '--artifacts-dir', '$AGENT_KERNEL_SWEBENCH_REPO/.agent-runlab-artifacts', '--model', config.model, '--max-turns', String(maxTurns), '--system-prompt-preset', preset])
    return inHost(command([
      'pnpm', '--filter', '@agent-kernel/host', 'exec', 'tsx',
      join(HOST_ROOT, 'bin', 'run-agent-runlab-swebench.ts'),
      '--prompt-file', '$AGENT_KERNEL_SWEBENCH_PROMPT_FILE',
      '--repo', '$AGENT_KERNEL_SWEBENCH_REPO',
      '--session-log', '$AGENT_KERNEL_SWEBENCH_SESSION_LOG',
      '--sessions-dir', '$AGENT_KERNEL_SWEBENCH_REPO/.agent-runlab-sessions',
      '--artifacts-dir', '$AGENT_KERNEL_SWEBENCH_REPO/.agent-runlab-artifacts',
      '--model', config.model,
      '--max-turns', String(maxTurns),
      '--system-prompt-preset', preset,
    ]))
  },
}

const claudeCode: AgentBackend = {
  descriptor: {
    id: 'claude-code',
    label: 'Claude Code SDK',
    description: 'Run Claude Code through the Anthropic Agent SDK with isolated settings and preserved SDK artifacts.',
    evidenceLevel: 'predictions_only',
    production: true,
    available: existsSync(join(HOST_ROOT, 'bin', 'run-claude-code-swebench.ts')) || existsSync(join(RELEASE_ROOT, 'claude-code-swebench-runner.cjs')),
    capabilities: productionCapabilities,
    configFields: [
      { key: 'maxTurns', label: 'Maximum turns', kind: 'number', required: false, defaultValue: 40 },
      { key: 'baseUrl', label: 'Anthropic base URL', kind: 'string', required: false },
      { key: 'smallFastModel', label: 'Small fast model', kind: 'string', required: false },
    ],
  },
  validate(config) {
    return validateModelAndPositive(config, ['maxTurns'])
  },
  command(config) {
    const maxTurns = positive(config.config.maxTurns) ?? 40
    const packaged = join(RELEASE_ROOT, 'claude-code-swebench-runner.cjs')
    if (existsSync(packaged)) return command([process.execPath, packaged, '--prompt-file', '$AGENT_KERNEL_SWEBENCH_PROMPT_FILE', '--repo', '$AGENT_KERNEL_SWEBENCH_REPO', '--artifacts-dir', '$AGENT_KERNEL_SWEBENCH_REPO/.claude-code-sdk-artifacts', '--model', config.model, '--max-turns', String(maxTurns), ...(string(config.config.baseUrl) ? ['--base-url', string(config.config.baseUrl)!] : []), ...(string(config.config.smallFastModel) ? ['--small-fast-model', string(config.config.smallFastModel)!] : [])])
    return inHost(command([
      'pnpm', '--filter', '@agent-kernel/host', 'exec', 'tsx',
      join(HOST_ROOT, 'bin', 'run-claude-code-swebench.ts'),
      '--prompt-file', '$AGENT_KERNEL_SWEBENCH_PROMPT_FILE',
      '--repo', '$AGENT_KERNEL_SWEBENCH_REPO',
      '--artifacts-dir', '$AGENT_KERNEL_SWEBENCH_REPO/.claude-code-sdk-artifacts',
      '--model', config.model,
      '--max-turns', String(maxTurns),
      ...(string(config.config.baseUrl) ? ['--base-url', string(config.config.baseUrl)!] : []),
      ...(string(config.config.smallFastModel) ? ['--small-fast-model', string(config.config.smallFastModel)!] : []),
    ]))
  },
}

const customCommand: AgentBackend = {
  descriptor: {
    id: 'custom-command',
    label: 'Custom command',
    description: 'Run an explicit operator-supplied command once per isolated instance.',
    evidenceLevel: 'predictions_only',
    production: true,
    available: true,
    capabilities: { ...productionCapabilities, sessionLog: false, trace: false, configurableTools: false },
    configFields: [{ key: 'command', label: 'Shell command', kind: 'string', required: true }],
  },
  validate(config) {
    const errors = config.model.trim() ? [] : ['model is required']
    if (!string(config.config.command)) errors.push('config.command is required')
    return { ok: errors.length === 0, errors, warnings: ['Custom commands may not produce a replayable session or trace.'] }
  },
  command(config) {
    const value = string(config.config.command)
    if (!value) throw new Error('custom-command requires config.command')
    return value
  },
}

const smoke: AgentBackend = {
  descriptor: {
    id: 'smoke',
    label: 'Pipeline smoke test',
    description: 'Produce an empty patch to verify plumbing only. This is not benchmark evidence.',
    evidenceLevel: 'smoke',
    production: false,
    available: true,
    capabilities: { realAgent: false, sessionLog: false, trace: false, cancellation: false, configurableModel: false, configurableTools: false, resume: false },
    configFields: [],
  },
  validate() {
    return { ok: true, errors: [], warnings: ['Smoke results cannot be used as official benchmark evidence.'] }
  },
  command() {
    return 'true'
  },
}

const BACKENDS: Readonly<Record<AgentBackendId, AgentBackend>> = {
  'agent-runlab': agentRunLab,
  'claude-code': claudeCode,
  'custom-command': customCommand,
  smoke,
}

export function listAgentBackends(): readonly AgentBackendDescriptor[] {
  return Object.values(BACKENDS).map((backend) => backend.descriptor)
}

export function getAgentBackend(id: AgentBackendId): AgentBackend {
  const backend = BACKENDS[id]
  if (!backend) throw new Error(`unknown agent backend: ${id}`)
  return backend
}

function validateModelAndPositive(config: AgentBackendExecutionConfig, fields: readonly string[]): AgentBackendValidation {
  const errors = config.model.trim() ? [] : ['model is required']
  for (const field of fields) {
    const value = config.config[field]
    if (value !== undefined && positive(value) === undefined) errors.push(`${field} must be a positive number`)
  }
  return { ok: errors.length === 0, errors, warnings: [] }
}

function positive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function inHost(value: string): string {
  return `cd ${shell(HOST_ROOT)} && ${value}`
}

function command(parts: readonly string[]): string {
  return parts.map((part) => part.startsWith('$AGENT_KERNEL_') ? `"${part}"` : shell(part)).join(' ')
}

function shell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
