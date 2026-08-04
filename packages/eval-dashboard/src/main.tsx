import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, DashboardErrorBoundary } from './app.js'
import './styles.css'
import './professional.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(<StrictMode><DashboardErrorBoundary><App /></DashboardErrorBoundary></StrictMode>)
