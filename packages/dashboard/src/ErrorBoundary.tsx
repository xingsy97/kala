import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ProductState } from './components/ui/product-state.js'
import { Typewriter } from './components/Typewriter.js'

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
    return <ErrorBoundaryFallback message={this.state.error.message} />
  }
}

function ErrorBoundaryFallback({ message }: { message: string }): JSX.Element {
  const { t } = useTranslation()
  const diagnostics = `Agent RunLab dashboard render failure\n${message}`
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <ProductState
        kind="fatal"
        title={t('errorBoundary.title')}
        description={t('errorBoundary.body')}
        detail={<><Typewriter text={message} charMs={5} /></>}
        primary={{ label: t('common.reload'), onClick: () => window.location.reload() }}
        secondary={{ label: 'Copy diagnostics', onClick: () => { void navigator.clipboard?.writeText(diagnostics) } }}
      />
    </main>
  )
}
