import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { App } from './app.js'
import { GroupedToolCallsDemo } from './demoGroupedToolCalls.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import './i18n/index.js'
import './index.css'
import 'katex/dist/katex.min.css'
import { initializeTheme } from './lib/theme.js'

const STALE_CHUNK_RELOAD_KEY = 'ak-stale-chunk-reload'
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  try {
    if (sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY) === '1') return
    sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, '1')
  } catch {
    // Storage can be unavailable in hardened/private browser modes; reloading
    // is still preferable to leaving the dashboard on a permanent crash page.
  }
  window.location.reload()
})
window.setTimeout(() => {
  try { sessionStorage.removeItem(STALE_CHUNK_RELOAD_KEY) } catch { /* noop */ }
}, 10_000)

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
// Remove the pure-CSS splash (index.html) before mounting so React's
// createRoot() starts from an empty container.
document.getElementById('ak-splash')?.remove()
const demo = new URLSearchParams(window.location.search).get('demo')

initializeTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {demo === 'grouped-tool-calls' ? <GroupedToolCallsDemo /> : <App />}
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
