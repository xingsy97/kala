import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ProductState } from './components/ui/product-state.js'
import { isStaleDashboardAssetError, recoverStaleDashboard } from './lib/dashboard-version-recovery.js'

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
    return <ErrorBoundaryFallback error={this.state.error} />
  }
}

export function ErrorBoundaryFallback({ error }: { error: Error }): JSX.Element {
  const { t } = useTranslation()
  const stale = isStaleDashboardAssetError(error)
  const [recovery, setRecovery] = useState<'checking' | 'failed'>(stale ? 'checking' : 'failed')
  const diagnostics = useMemo(() => `Agent RunLab dashboard render failure\n${error.name}: ${error.message}`, [error])
  useEffect(() => {
    if (!stale) return
    let mounted = true
    void recoverStaleDashboard(error).then((result) => {
      if (mounted && result !== 'reloading') setRecovery('failed')
    }, () => {
      if (mounted) setRecovery('failed')
    })
    return () => { mounted = false }
  }, [error, stale])
  if (recovery === 'checking') {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
        <ProductState kind="loading" title={t('errorBoundary.updatingTitle')} description={t('errorBoundary.updatingBody')} />
      </main>
    )
  }
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <ProductState
        kind="fatal"
        title={t('errorBoundary.title')}
        description={t('errorBoundary.body')}
        primary={{ label: t('common.reload'), onClick: () => window.location.reload() }}
        secondary={{ label: t('errorBoundary.copyDiagnostics'), onClick: () => { void navigator.clipboard?.writeText(diagnostics) } }}
      />
    </main>
  )
}
