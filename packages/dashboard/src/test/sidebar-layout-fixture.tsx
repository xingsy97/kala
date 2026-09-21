import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import '../index.css'
import { i18n } from '../i18n/index.js'
import { ProductSwitcher, SidebarBrand } from '../app-shell/AppShellNav.js'
import { Explorer } from '../features/explorer/Explorer.js'

const params = new URLSearchParams(location.search)
const sidebarWidth = Number(params.get('sidebar') ?? 280)
const scale = Number(params.get('scale') ?? 1)
document.documentElement.style.setProperty('--ak-interface-scale', String(scale))
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
void i18n.changeLanguage('en')

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Fixture(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <main className="min-h-screen bg-background p-6 text-foreground">
        <aside
          className="ak-explorer-surface flex h-[42rem] min-h-0 flex-col overflow-hidden border border-border/35 bg-card/80"
          data-testid="matrix-sidebar"
          style={{ width: sidebarWidth }}
        >
          <div className="flex flex-none flex-col px-3 py-2">
            <div className="flex h-9 items-center gap-2">
              <SidebarBrand />
              <span className="min-w-0 flex-1" />
              <button type="button" className="h-9 w-9 flex-none rounded-xl text-muted-foreground" aria-label="Collapse sidebar" data-testid="matrix-collapse">◀</button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Explorer
              executors={[]}
              sessions={[]}
              selectedSessionId={null}
              onSelect={() => {}}
              onNewSession={() => {}}
              onConnectWorkspace={() => {}}
              onDelete={() => {}}
              onRename={() => {}}
              embeddedHeader
              headerLeading={<ProductSwitcher section="agent" onSelect={() => {}} adaptive />}
            />
          </div>
        </aside>
      </main>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
requestAnimationFrame(() => requestAnimationFrame(() => { document.body.dataset.fixtureReady = 'true' }))
