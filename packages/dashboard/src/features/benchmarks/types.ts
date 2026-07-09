export type BenchmarkRunKind = 'swebench' | 'swe-bench' | 'terminal-bench'

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
}
