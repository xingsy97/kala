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
  const installWindowControls = () => {
    if (document.getElementById('kala-desktop-window-controls')) return
    const host = document.createElement('div')
    host.id = 'kala-desktop-window-controls'
    host.style.cssText = 'position:fixed;top:2px;right:4px;width:132px;height:32px;z-index:2147483647'
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = `<style>:host{font:13px system-ui;color:#cbd5e1;user-select:none}.controls{box-sizing:border-box;display:flex;width:100%;height:32px;overflow:hidden;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;background:color-mix(in srgb,#111827 88%,transparent);box-shadow:0 1px 4px #0004;backdrop-filter:blur(12px)}:host([data-docked="true"]){color:inherit}:host([data-docked="true"]) .controls{border-color:transparent;border-radius:6px;background:transparent;box-shadow:none;backdrop-filter:none}.drag{width:24px;flex:none;cursor:grab;background:radial-gradient(circle,currentColor 1px,transparent 1.5px) 6px 5px/6px 6px;opacity:.55}.drag:active{cursor:grabbing}button{width:36px;border:0;background:transparent;color:inherit;font:16px system-ui;cursor:pointer;border-radius:5px}button:hover{background:color-mix(in srgb,currentColor 14%,transparent)}.close:hover{background:#dc2626;color:#fff}button:focus-visible{outline:2px solid #60a5fa;outline-offset:-3px}</style><div class="controls" aria-label="Window controls"><div class="drag" aria-hidden="true"></div><button data-action="minimize" aria-label="Minimize">−</button><button data-action="toggle-maximize" aria-label="Maximize or restore">□</button><button class="close" data-action="close" aria-label="Close">×</button></div>`
    root.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => void invoke('desktop_window', { action: button.dataset.action })))
    const drag = root.querySelector('.drag')
    drag.addEventListener('mousedown', (event) => { if (event.button === 0) void invoke('desktop_window', { action: 'start-dragging' }) })
    drag.addEventListener('dblclick', () => void invoke('desktop_window', { action: 'toggle-maximize' }))
    document.body.appendChild(host)
    const dock = () => {
      const slots = [...document.querySelectorAll('[data-kala-desktop-window-controls-slot="true"]')]
      const slot = slots.find((candidate) => candidate.getClientRects().length > 0) ?? slots[0]
      if (slot) {
        host.dataset.docked = 'true'
        host.style.cssText = 'position:relative;inset:auto;width:132px;height:32px;display:block;flex:0 0 132px;z-index:10'
        if (host.parentNode !== slot) slot.appendChild(host)
      } else if (host.parentNode !== document.body) {
        delete host.dataset.docked
        host.style.cssText = 'position:fixed;top:2px;right:4px;width:132px;height:32px;z-index:2147483647'
        document.body.appendChild(host)
      }
    }
    dock()
    new MutationObserver(dock).observe(document.body, { childList: true, subtree: true })
  }
  if (document.readyState === 'loading' || !document.body) document.addEventListener('DOMContentLoaded', installWindowControls, { once: true })
  else installWindowControls()
  Object.defineProperty(window, '__RUNLAB_DESKTOP_BRIDGE__', {
    value: Object.freeze({
      version: 1,
      getInfo: () => invoke('desktop_status'),
      confirmConnection: () => invoke('desktop_connection_ready'),
      setActivity: (state) => invoke('desktop_ui', { state }),
      notify: (notification) => invoke('desktop_notify', { notification }),
      readClipboardImage: () => invoke('desktop_clipboard_image'),
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
