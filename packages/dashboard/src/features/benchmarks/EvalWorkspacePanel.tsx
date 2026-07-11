import { EvalRunsView } from '../artifacts/EvalRunsView.js'

export function EvalWorkspacePanel({ onOpenSession }: { onOpenSession?(sessionId: string): void }): JSX.Element {
  return <EvalRunsView onOpenSession={onOpenSession} />
}
