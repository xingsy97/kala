import type { AgentEvent, ApprovalMode } from '@agent-kernel/kernel'
import {
  KERNEL_AGENT_RUNTIME_CAPABILITIES,
  type AgentRuntimeDescriptor,
} from '@agent-kernel/shared'

import type { LoopHandle } from '../loop-types.js'
import type { SessionRecord } from '../store/session.js'
import type { AgentRuntime, AgentRuntimeSendInput } from './types.js'

export class KernelAgentRuntime implements AgentRuntime {
  readonly id = 'kernel' as const

  constructor(private readonly loop: LoopHandle) {}

  descriptor(): AgentRuntimeDescriptor {
    return {
      id: this.id,
      label: 'Agent RunLab',
      description: 'Agent Kernel deterministic reducer and host loop',
      available: true,
      status: 'ready',
      capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
    }
  }

  async send(record: SessionRecord, input: AgentRuntimeSendInput): Promise<void> {
    await this.loop.dispatch(record.sessionId, {
      kind: 'user_message',
      text: input.text,
      ...(input.content ? { content: input.content } : {}),
    }, input.model ? { model: input.model } : undefined)
  }

  async cancel(record: SessionRecord): Promise<void> {
    await this.loop.dispatch(record.sessionId, { kind: 'cancel' })
  }

  async approve(record: SessionRecord, callId: string): Promise<void> {
    await this.dispatch(record, { kind: 'user_approve', callId })
  }

  async reject(record: SessionRecord, callId: string, reason?: string): Promise<void> {
    await this.dispatch(record, { kind: 'user_reject', callId, ...(reason ? { reason } : {}) })
  }

  async setApprovalMode(record: SessionRecord, mode: ApprovalMode): Promise<void> {
    await this.dispatch(record, { kind: 'approval_mode_changed', mode })
  }

  async close(): Promise<void> {}

  private async dispatch(record: SessionRecord, event: AgentEvent): Promise<void> {
    await this.loop.dispatch(record.sessionId, event)
  }
}
