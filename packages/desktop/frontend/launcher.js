const endpoint = document.getElementById('endpoint')
const status = document.getElementById('status')
const submit = document.getElementById('submit')
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)
window.addEventListener('runlab:connection-error', (event) => {
  status.textContent = String(event.detail)
  submit.disabled = false
})
async function connect() {
  submit.disabled = true
  status.textContent = 'Connecting…'
  try {
    const origin = await invoke('connect', { endpoint: endpoint.value })
    endpoint.value = origin
    status.textContent = ''
  } catch (error) {
    status.textContent = String(error)
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
    if (saved.origin) endpoint.value = saved.origin
    else {
      try { endpoint.value = localStorage.getItem('runlab-desktop-origin') || endpoint.value }
      catch (error) { console.warn('Legacy server preference is unavailable:', error) }
    }
    if (saved.autoConnect) await connect()
  } catch (error) {
    status.textContent = String(error)
  } finally {
    submit.disabled = false
  }
}
void initialize()
