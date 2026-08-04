import { ClaudeCodeAgentBackend } from '@agent-kernel/eval-agent-claude-code'
import { CodexAgentBackend } from '@agent-kernel/eval-agent-codex'
import { AgentRunLabBackend } from '@agent-kernel/eval-agent-runlab'

import { certifyOfficialAgentBackend } from './suite.js'

const HASH = 'a'.repeat(64)

certifyOfficialAgentBackend({
  name: 'Agent RunLab', create: () => new AgentRunLabBackend(),
  variant: () => ({ variantId: 'runlab', backendId: 'agent-runlab', agentVersion: '1', model: { provider: 'openai', modelId: 'fixture-model' }, configHash: HASH, config: { provider: 'openai' }, credentialRefs: [{ referenceId: 'openai-key', provider: 'openai', scope: [] }] }),
})

certifyOfficialAgentBackend({
  name: 'Claude Code', create: () => new ClaudeCodeAgentBackend(),
  variant: () => ({ variantId: 'claude', backendId: 'claude-code', agentVersion: '1', model: { provider: 'anthropic', modelId: 'fixture-model' }, configHash: HASH, config: {}, credentialRefs: [{ referenceId: 'anthropic-key', provider: 'anthropic', scope: [] }] }),
})

certifyOfficialAgentBackend({
  name: 'Codex', create: () => new CodexAgentBackend(),
  variant: () => ({ variantId: 'codex', backendId: 'codex', agentVersion: '1', model: { provider: 'openai', modelId: 'fixture-model' }, configHash: HASH, config: { transport: 'app-server' }, credentialRefs: [{ referenceId: 'openai-key', provider: 'openai', scope: [] }] }),
})
