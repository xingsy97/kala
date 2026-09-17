Object.defineProperty(window, '__RUNLAB_DESKTOP__', { value: true, writable: false, configurable: false })
;(() => {
  const listeners = new Set()
  let pendingSession = null
  const validSession = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  const deliver = (event) => {
    if (event.type === 'open-session' && listeners.size === 0) {
      pendingSession = event.sessionId
      return
    }
    for (const listener of listeners) listener(event)
  }
  const openSession = (sessionId) => {
    if (!validSession(sessionId)) return
    const url = new URL(location.href)
    if (url.searchParams.has('desktopSession')) {
      url.searchParams.delete('desktopSession')
      history.replaceState(history.state, '', url)
    }
    deliver({ type: 'open-session', sessionId })
  }
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)
  Object.defineProperty(window, '__RUNLAB_DESKTOP_BRIDGE__', {
    value: Object.freeze({
      version: 1,
      getInfo: () => invoke('desktop_status'),
      confirmConnection: () => invoke('desktop_connection_ready'),
      setActivity: (state) => invoke('desktop_ui', { state }),
      notify: (notification) => invoke('desktop_notify', { notification }),
      subscribe: (listener) => {
        if (typeof listener !== 'function') throw new TypeError('Desktop subscription requires a listener')
        listeners.add(listener)
        if (pendingSession !== null) {
          const sessionId = pendingSession
          pendingSession = null
          listener({ type: 'open-session', sessionId })
        }
        return () => listeners.delete(listener)
      },
    }),
    writable: false, configurable: false,
  })
  window.addEventListener('runlab:navigate-session', (event) => openSession(event.detail?.sessionId))
  window.addEventListener('runlab:window-state', (event) => {
    if (typeof event.detail?.focused === 'boolean' && typeof event.detail?.visible === 'boolean') {
      deliver({ type: 'window-state', focused: event.detail.focused, visible: event.detail.visible })
    }
  })
  openSession(new URL(location.href).searchParams.get('desktopSession'))
})()
// Ordinary links stay in this unprivileged webview. HTTPS identity redirects
// remain possible; native navigation validation rejects local/file schemes.
document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (link?.target === '_blank' && !link.hasAttribute('download')) link.target = '_self'
}, true)
