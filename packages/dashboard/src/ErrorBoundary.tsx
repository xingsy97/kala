import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ProductState } from './components/ui/product-state.js'
import { dashboardBootIdentity, isStaleDashboardAssetError, recoverStaleDashboard } from './lib/dashboard-version-recovery.js'
import { writeTextToClipboard } from './lib/clipboard.js'
import { forcePwaRefresh } from './lib/pwa.js'

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
  const canCheckVersion = useMemo(() => {
    const identity = dashboardBootIdentity()
    return identity.generation !== undefined || identity.releaseId !== undefined
  }, [])
  const [recovery, setRecovery] = useState<'checking' | 'failed'>(stale || canCheckVersion ? 'checking' : 'failed')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const diagnostics = useMemo(() => `Kala dashboard render failure\n${error.name}: ${error.message}`, [error])
  useEffect(() => {
    if (!stale && !canCheckVersion) return
    let mounted = true
    void recoverStaleDashboard(error, { recoverWhenVersionChanged: true }).then((result) => {
      if (mounted && result !== 'reloading') setRecovery('failed')
    }, () => {
      if (mounted) setRecovery('failed')
    })
    return () => { mounted = false }
  }, [canCheckVersion, error, stale])
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
        primary={{
          label: t('pwa.forceRefresh'),
          onClick: () => {
            setRecovery('checking')
            void forcePwaRefresh().catch(() => {
              const url = new URL(window.location.href)
              url.searchParams.set('__kala_refresh', String(Date.now()))
              window.location.replace(url.toString())
            })
          },
        }}
        secondary={{
          label: copyState === 'copied' ? t('common.copied') : copyState === 'failed' ? t('common.copyFailed') : t('errorBoundary.copyDiagnostics'),
          onClick: () => {
            void writeTextToClipboard(diagnostics).then(() => setCopyState('copied'), () => setCopyState('failed'))
          },
        }}
      />
    </main>
  )
}
