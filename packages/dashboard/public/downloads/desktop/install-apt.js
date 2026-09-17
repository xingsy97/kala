import { aptInstallSnippet } from './apt-snippet.js'

const status = document.getElementById('apt-status')
try {
  const response = await fetch('./apt-install.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
  if (response.status !== 404) {
    if (!response.ok) throw new Error('Could not load approved APT installation settings.')
    const config = await response.json()
    const snippet = aptInstallSnippet(config)
    document.getElementById('apt-commands').textContent = snippet
    document.getElementById('apt-available').hidden = false
    status.textContent = 'Paste this entire Bash block to verify the repository key, add the source and install. Compare the pinned fingerprint with the independently published release announcement. Subsequent system APT upgrades update the desktop client.'
    const copy = document.getElementById('apt-copy')
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(snippet)
        copy.textContent = 'Copied'
      } catch {
        copy.textContent = 'Copy unavailable — select the command below'
      }
    })
  }
} catch (error) {
  status.textContent = error instanceof Error ? error.message : 'APT installation settings are unavailable.'
}
