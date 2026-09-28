const endpoint = document.getElementById('endpoint')
const status = document.getElementById('status')
const submit = document.getElementById('submit')
const warning = document.getElementById('http-warning')
const security = document.getElementById('endpoint-security')
const launcher = document.getElementById('launcher')
const currentConnection = document.getElementById('current-connection')
const currentEndpoint = document.getElementById('current-endpoint')
const submitLabel = document.getElementById('submit-label')
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)

function inspectEndpoint(value) {
  const input = value.trim()
  if (!input || /[\u0000-\u001f\u007f\\]/u.test(input)) return { error: 'Enter a valid HTTP or HTTPS Dashboard origin.' }
  let url
  try { url = new URL(input) } catch { return { error: 'Enter a valid HTTP or HTTPS Dashboard origin.' } }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    return { error: 'Use an HTTP or HTTPS origin without credentials, paths, query parameters, or fragments.' }
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  return { origin: url.origin, secure: url.protocol === 'https:' || loopback, loopback }
}

function showStatus(message = '', kind = '') {
  status.textContent = message
  if (kind) status.dataset.kind = kind
  else delete status.dataset.kind
}

function updateEndpointState(showError = false) {
  const result = inspectEndpoint(endpoint.value)
  endpoint.setCustomValidity(result.error || '')
  endpoint.setAttribute('aria-invalid', String(Boolean(showError && result.error)))
  warning.hidden = !result.origin || result.secure
  if (!result.origin) {
    security.textContent = ''
    delete security.dataset.kind
  } else if (result.loopback) {
    security.textContent = 'Local loopback · native desktop features available'
    security.dataset.kind = 'local'
  } else if (result.secure) {
    security.textContent = 'Encrypted with HTTPS · native desktop features available'
    security.dataset.kind = 'secure'
  } else {
    security.textContent = 'HTTP connection · browser-safe mode only'
    security.dataset.kind = 'warning'
  }
  if (showError && result.error) showStatus(result.error, 'error')
  return result
}

for (const button of document.querySelectorAll('[data-window-action]')) {
  button.addEventListener('click', () => void invoke('desktop_window', { action: button.dataset.windowAction }))
}
const heading = document.querySelector('.launcher-heading')
heading.addEventListener('mousedown', (event) => {
  if (event.button === 0 && !event.target.closest('button')) void invoke('desktop_window', { action: 'start-dragging' })
})
heading.addEventListener('dblclick', (event) => {
  if (!event.target.closest('button')) void invoke('desktop_window', { action: 'toggle-maximize' })
})
endpoint.addEventListener('input', () => {
  showStatus()
  updateEndpointState(false)
})
window.addEventListener('runlab:connection-error', (event) => {
  showStatus(String(event.detail), 'error')
  submit.disabled = false
})

async function connect() {
  const result = updateEndpointState(true)
  if (!result.origin) return
  endpoint.value = result.origin
  submit.disabled = true
  showStatus('Connecting…')
  try {
    const origin = await invoke('connect', { endpoint: result.origin })
    endpoint.value = origin
    updateEndpointState(false)
    showStatus()
  } catch (error) {
    showStatus(String(error), 'error')
  } finally {
    submit.disabled = false
  }
}

document.getElementById('connect').addEventListener('submit', async (event) => {
  event.preventDefault()
  await connect()
})

async function initialize() {
  submit.disabled = true
  try {
    const saved = await invoke('launcher_bootstrap')
    if (saved.origin) {
      endpoint.value = saved.origin
      currentEndpoint.textContent = saved.origin
      currentConnection.hidden = false
      launcher.dataset.mode = 'change'
      submitLabel.textContent = 'Connect to this Dashboard'
    }
    else {
      try { endpoint.value = localStorage.getItem('runlab-desktop-origin') || endpoint.value }
      catch (error) { console.warn('Legacy server preference is unavailable:', error) }
    }
    updateEndpointState(false)
    if (saved.autoConnect) await connect()
  } catch (error) {
    showStatus(String(error), 'error')
  } finally {
    submit.disabled = false
  }
}
void initialize()
