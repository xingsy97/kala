export type DagRunStatus = 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type DagNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'replaced'

export type DagDecisionStatus = 'pending' | 'answered' | 'cancelled'
export type DagRiskLevel = 'low' | 'medium' | 'high'
export type DagNodeAttemptStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'waiting_user'
  | 'replaced'

export type DagToolActivityCategory = 'read' | 'shell' | 'write' | 'network' | 'install' | 'system' | 'other'

export type DagToolActivity = {
  callId: string
  name: string
  category: DagToolActivityCategory
  status: 'succeeded' | 'failed' | 'unknown'
  summary: string
}

export type DagNode = {
  id: string
  runId: string
  title: string
  instructions: string
  status: DagNodeStatus
  depth: number
  writeScopes: readonly string[]
  estimatedDurationMinutes?: number
  attempt: number
  childSessionId?: string
  progress?: string
  result?: string
  error?: string
  replacedBy?: string
  startedAt?: string
  completedAt?: string
  toolActivity: readonly DagToolActivity[]
}

export type DagEdge = {
  id: string
  runId: string
  source: string
  target: string
}

export type DagDecision = {
  id: string
  runId: string
  nodeId: string
  question: string
  context: string
  choices: readonly string[]
  allowFreeform: boolean
  recommendation?: string
  reason?: string
  riskLevel?: DagRiskLevel
  status: DagDecisionStatus
  answer?: string
  createdAt: string
  answeredAt?: string
}

export type DagEvent = {
  id: number
  runId: string
  type: 'run' | 'node' | 'decision' | 'graph' | 'lease'
  message: string
  nodeId?: string
  createdAt: string
}

export type DagNodeAttempt = {
  id: number
  runId: string
  nodeId: string
  attempt: number
  workerId: string
  status: DagNodeAttemptStatus
  startedAt: string
  completedAt?: string
  result?: string
  error?: string
}

export type DagGraphVersion = {
  runId: string
  version: number
  resultNodeId: string
  nodes: readonly DagGraphVersionNode[]
  edges: readonly DagPlanEdgeInput[]
  createdAt: string
}

export type DagGraphVersionNode = {
  id: string
  title: string
  instructions: string
  depth: number
  writeScopes: readonly string[]
  estimatedDurationMinutes?: number
}

export type DagRun = {
  id: string
  parentSessionId: string
  objective: string
  status: DagRunStatus
  graphVersion: number
  resultNodeId?: string
  result?: string
  error?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
  nodes: readonly DagNode[]
  edges: readonly DagEdge[]
  decisions: readonly DagDecision[]
  events: readonly DagEvent[]
  attempts?: readonly DagNodeAttempt[]
  graphHistory?: readonly DagGraphVersion[]
}

export type DagPlanNodeInput = {
  id: string
  title: string
  instructions: string
  writeScopes?: readonly string[]
  estimatedDurationMinutes?: number
}

export type DagPlanEdgeInput = {
  source: string
  target: string
}

export type DagGraphPatch = {
  expectedGraphVersion: number
  resultNodeId: string
  nodes: readonly DagPlanNodeInput[]
  edges: readonly DagPlanEdgeInput[]
}
