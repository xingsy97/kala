import { AgentBackendDescriptorSchema } from '@agent-kernel/eval-protocol'
import type { AgentRunInput, AgentBackendPlugin } from '@agent-kernel/eval-sdk'
import { StructuredCliAgentBackend, mapCredentialEnvironment, normalizedEvent } from '@agent-kernel/eval-agent-cli-common'
import { codexProviderConfigArgs } from './provider-config.js'

export class CodexAgentBackend extends StructuredCliAgentBackend {
  readonly descriptor = AgentBackendDescriptorSchema.parse({ schemaVersion: 1, id: 'codex', label: 'Codex', version: '0.0.0', configSchemaVersion: 1, ranked: true, evidenceLevel: 'native', capabilities: { nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true, absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: true, finalDiff: true, usage: 'unavailable_explicit' } })
  protected binary(): string { return 'codex' }
  protected acceptedCredentialProviders(): readonly string[] { return ['openai'] }
  protected credentialEnvironment(input: AgentRunInput) { return mapCredentialEnvironment(input, { openai: 'OPENAI_API_KEY' }) }
  protected async command(input: AgentRunInput) {
    const prepared = await input.sandbox.execute({ argv: ['mkdir', '-p', '/tmp/agent-home/codex'], timeoutMs: 10_000 })
    if (prepared.exitCode !== 0) throw new Error('Codex isolated config directory could not be created')
    const config = input.variant.config
    const transport = config.transport === 'exec-json' ? 'exec-json' : 'app-server'
    const finalResponsePath = '/tmp/agent-home/final-response.txt'
    if (transport === 'app-server') {
      const argv = ['agent-eval-codex-app-server', '--model', input.variant.model.modelId, '--cwd', input.sandbox.workspacePath, '--final-response', finalResponsePath]
      if (typeof config.reasoningEffort === 'string') argv.push('--effort', config.reasoningEffort)
      if (typeof config.baseUrl === 'string') argv.push('--base-url', config.baseUrl)
      return { argv, env: { CODEX_HOME: '/tmp/agent-home/codex' }, stdin: input.task.prompt, finalResponsePath }
    }
    const argv = ['codex', 'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--output-last-message', finalResponsePath, '--model', input.variant.model.modelId]
    if (typeof config.baseUrl === 'string') argv.push(...codexProviderConfigArgs(config.baseUrl))
    argv.push('-')
    return { argv, env: { CODEX_HOME: '/tmp/agent-home/codex' }, stdin: input.task.prompt, finalResponsePath }
  }
  protected normalize(native: unknown, sequence: number, at: string) {
    const type = native && typeof native === 'object' && typeof (native as Record<string, unknown>).type === 'string' ? String((native as Record<string, unknown>).type) : ''
    const kind = /command|tool/iu.test(type) ? 'tool_call' : /error|fail/iu.test(type) ? 'error' : /usage|token/iu.test(type) ? 'usage' : /message|response|item/iu.test(type) ? 'message' : 'status'
    return normalizedEvent(native, sequence, at, kind)
  }
}
export function createCodexAgentBackend(): CodexAgentBackend { return new CodexAgentBackend() }
export const evaluationPlugins: readonly AgentBackendPlugin[] = [{ kind: 'agent-backend', descriptor: createCodexAgentBackend().descriptor, create: createCodexAgentBackend }]
