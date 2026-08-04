import { AgentBackendDescriptorSchema } from '@agent-kernel/eval-protocol'
import type { AgentRunInput, AgentBackendPlugin } from '@agent-kernel/eval-sdk'
import { StructuredCliAgentBackend, mapCredentialEnvironment, normalizedEvent } from '@agent-kernel/eval-agent-cli-common'

export class ClaudeCodeAgentBackend extends StructuredCliAgentBackend {
  readonly descriptor = AgentBackendDescriptorSchema.parse({ schemaVersion: 1, id: 'claude-code', label: 'Claude Code', version: '0.0.0', configSchemaVersion: 1, ranked: true, evidenceLevel: 'native', capabilities: { nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true, absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: true, finalDiff: true, usage: 'available' } })
  protected binary(): string { return 'claude' }
  protected acceptedCredentialProviders(): readonly string[] { return ['anthropic'] }
  protected credentialEnvironment(input: AgentRunInput) { return mapCredentialEnvironment(input, { anthropic: 'ANTHROPIC_API_KEY' }) }
  protected async command(input: AgentRunInput) {
    const user = await sandboxUser(input)
    const prepared = await input.sandbox.execute({
      argv: ['install', '-d', '-m', '0700', '-o', user.name, '-g', user.group, '/tmp/agent-home/claude'],
      timeoutMs: 10_000,
    })
    if (prepared.exitCode !== 0) throw new Error('Claude Code isolated config directory could not be created')
    const mcpConfigPath = '/tmp/agent-home/claude/mcp.json'
    const configured = await input.sandbox.execute({ argv: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(mcpConfigPath)}, '{"mcpServers":{}}', { mode: 0o600 })`], timeoutMs: 10_000 })
    if (configured.exitCode !== 0) throw new Error('Claude Code isolated MCP configuration could not be created')
    const permissions = await input.sandbox.execute({ argv: ['chown', '-R', user.name + ':' + user.group, '/tmp/agent-home/claude', input.sandbox.workspacePath], timeoutMs: 30_000 })
    if (permissions.exitCode !== 0) throw new Error('Claude Code sandbox ownership could not be prepared')
    const claude = ['claude', '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--bare', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', mcpConfigPath, '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions', '--model', input.variant.model.modelId, input.task.prompt]
    const argv = ['runuser', '-u', user.name, '--preserve-environment', '--', ...claude]
    return { argv, env: { CLAUDE_CONFIG_DIR: '/tmp/agent-home/claude', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...(typeof input.variant.config.baseUrl === 'string' ? { ANTHROPIC_BASE_URL: input.variant.config.baseUrl } : {}) } }
  }
  protected normalize(native: unknown, sequence: number, at: string) {
    const value = native && typeof native === 'object' ? native as Record<string, unknown> : {}
    const type = String(value.type ?? value.subtype ?? '')
    const kind = /tool/iu.test(type) ? 'tool_call' : /error/iu.test(type) ? 'error' : /result|assistant|message/iu.test(type) ? 'message' : /usage/iu.test(type) ? 'usage' : 'status'
    return normalizedEvent(native, sequence, at, kind)
  }
}

async function sandboxUser(input: AgentRunInput): Promise<{ name: string; group: string }> {
  for (const candidate of [{ name: 'ubuntu', group: 'ubuntu' }, { name: 'nobody', group: 'nogroup' }]) {
    const probe = await input.sandbox.execute({ argv: ['id', '-u', candidate.name], timeoutMs: 10_000 })
    if (probe.exitCode === 0) return candidate
  }
  throw new Error('Claude Code requires an unprivileged sandbox account (ubuntu or nobody)')
}
export function createClaudeCodeAgentBackend(): ClaudeCodeAgentBackend { return new ClaudeCodeAgentBackend() }
export const evaluationPlugins: readonly AgentBackendPlugin[] = [{ kind: 'agent-backend', descriptor: createClaudeCodeAgentBackend().descriptor, create: createClaudeCodeAgentBackend }]
