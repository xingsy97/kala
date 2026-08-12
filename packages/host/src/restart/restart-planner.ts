import type { AgentState } from '@agent-kernel/kernel'
import type {
  HostRestartMode,
  HostRestartSessionPlan,
} from '@agent-kernel/shared'
import { deriveSessionState } from '@agent-kernel/shared'

import type { LoopDrainSessionSnapshot } from '../loop-types.js'

export type RestartPlanSessionRecord = {
  readonly sessionId: string
  readonly label?: string
  readonly workspaceId?: string
  readonly workspaceName?: string
  readonly state: {
    readonly status: AgentState['status']
    readonly cursor: number
  }
}

export function buildRestartSessionPlans(input: {
  records: readonly RestartPlanSessionRecord[]
  mode: HostRestartMode
  snapshotFor(sessionId: string): LoopDrainSessionSnapshot
}): readonly HostRestartSessionPlan[] {
  return input.records.map((record) => planRestartSession({
    record,
    snapshot: input.snapshotFor(record.sessionId),
    mode: input.mode,
  }))
}

export function planRestartSession(input: {
  record: RestartPlanSessionRecord
  snapshot: LoopDrainSessionSnapshot
  mode: HostRestartMode
}): HostRestartSessionPlan {
  const { record, snapshot, mode } = input
  return {
    sessionId: record.sessionId,
    cursor: snapshot.cursor ?? record.state.cursor,
    initialStatus: record.state.status,
    checkpointStatus: checkpointStatusFor(snapshot),
    ...(snapshot.checkpointKind ? { checkpointKind: snapshot.checkpointKind } : {}),
    resumeAction: resumeActionFor(snapshot, mode),
    ...(record.label ? { label: record.label } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    ...(record.workspaceName ? { workspaceName: record.workspaceName } : {}),
  }
}

export function checkpointStatusFor(snapshot: Pick<LoopDrainSessionSnapshot, 'safe' | 'waiting'>): HostRestartSessionPlan['checkpointStatus'] {
  if (snapshot.safe) return snapshot.waiting === 'none' ? 'safe' : 'already_safe'
  if (snapshot.waiting === 'llm') return 'waiting_llm'
  if (snapshot.waiting === 'tool') return 'waiting_tool'
  if (snapshot.waiting === 'turn' || snapshot.waiting === 'compaction') return 'waiting_turn'
  if (snapshot.waiting === 'idle') return 'waiting_idle'
  return 'safe'
}

export function resumeActionFor(
  snapshot: Pick<LoopDrainSessionSnapshot, 'status'>,
  mode: HostRestartMode,
): HostRestartSessionPlan['resumeAction'] {
  if (mode === 'when_idle') return 'none'
  if (snapshot.status === 'missing') return 'none'
  return deriveSessionState({ status: snapshot.status }).restartResumeAction
}
