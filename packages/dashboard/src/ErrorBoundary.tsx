import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

type State = {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('dashboard render error', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
        <div className="flex max-w-lg flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-sm">
          <div className="text-sm font-semibold">Dashboard crashed while rendering</div>
          <div className="text-sm text-muted-foreground">
            Reload the page to reconnect to the host. The session log is stored on the host, so a render failure does not affect the agent state.
          </div>
          <pre className="max-h-40 overflow-auto rounded bg-muted p-3 text-xs text-muted-foreground">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="self-start rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
