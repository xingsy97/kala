export type BenchmarkRunKind = 'swebench' | 'swe-bench' | 'terminal-bench' | 'program-bench' | 'swe-marathon'

export type BenchmarkRunStatus = 'running' | 'complete' | 'failed' | 'pending'

export type BenchmarkRunSummary = {
  runId: string
  kind: BenchmarkRunKind
  label: string
  dataset: string
  split?: string
  model: string
  selectedCount: number
  status: BenchmarkRunStatus
  createdAt: string
  updatedAt: string
  totalInstances?: number
  resolved?: number
  evidenceLevel?: 'official' | 'native' | 'predictions_only' | 'smoke' | 'legacy_official'
  orchestrated?: boolean
  legacy?: boolean
  badCaseCount?: number
  comparison?: { agentRunLabResolved?: number; claudeCodeResolved?: number }
  backends?: Array<{
    key: string
    backendId: 'agent-runlab' | 'claude-code' | 'custom-command' | 'smoke'
    model: string
    state: string
    total?: number
    completed?: number
    resolved?: number
    failed?: number
    timedOut?: number
    error?: string
  }>
}
