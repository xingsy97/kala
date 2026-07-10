import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app.js'
import { GroupedToolCallsDemo } from './demoGroupedToolCalls.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import './i18n/index.js'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
const demo = new URLSearchParams(window.location.search).get('demo')
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      {demo === 'grouped-tool-calls' ? <GroupedToolCallsDemo /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
)
