import type { AgentState } from '@agent-kernel/kernel'

import type { TimelineEntry } from '../../session.js'

export type AgentProgress = {
  phase: 'idle' | 'thinking' | 'tools' | 'approval' | 'done' | 'error'
  label: string
}

export function deriveAgentProgress(state: AgentState | null, _timeline: readonly TimelineEntry[]): AgentProgress {
  const status = state?.status
  // Tool cards are the single source of truth for live tool activity. Do not
  // derive a second status from the lifetime timeline: a long tool can be
  // healthy for minutes, and cumulative call counts are not user progress.
  if (status === 'thinking') return { phase: 'thinking', label: 'Preparing the next step' }
  if (status === 'executing_tools') return { phase: 'tools', label: 'Working' }
  if (status === 'awaiting_approval') return { phase: 'approval', label: 'Waiting for approval' }
  if (status === 'error') return { phase: 'error', label: 'The turn needs attention' }
  if (status === 'done') return { phase: 'done', label: 'Turn complete' }
  return { phase: 'idle', label: 'Ready' }
}
