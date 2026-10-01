localStorage.setItem('ak-explorer-open', 'true')
localStorage.setItem('ak-inspector-open', 'true')
localStorage.setItem('ak-auto-hide-offline-workspaces', 'false')
localStorage.setItem('ak-hide-sub-agent-sessions', 'false')

const url = new URL(window.location.href)
if (!url.searchParams.has('sessionId')) {
  url.searchParams.set('sessionId', 'prototype-active')
  window.history.replaceState(null, '', url)
}

void import('../main.js')
