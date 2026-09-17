import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n/index.js'
import { DesktopUpdateEntry, DesktopUpdateSettings } from './DesktopUpdate.js'
import { loadDesktopDownload, loadDesktopUpdateMetadata } from '../lib/desktop-download.js'

vi.mock('../lib/desktop-download.js', () => ({
  desktopDownloadBase: '/downloads/desktop/',
  loadDesktopUpdateMetadata: vi.fn(), loadDesktopDownload: vi.fn(), loadDesktopApt: async () => null,
}))
const release = { schemaVersion: 2 as const, platform: 'linux-amd64' as const, version: '0.2.0~rc.4', artifact: { file: 'release.deb', sha256: 'a'.repeat(64), size: 100 }, dependencies: { file: 'deps.json', sha256: 'b'.repeat(64) }, checksums: { file: 'sums.txt', sha256: 'c'.repeat(64) } }
const desktopWindow = window as Window & { __RUNLAB_DESKTOP__?: boolean; __RUNLAB_DESKTOP_BRIDGE__?: unknown }
let clock = 0
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue((++clock) * 100_000)
  vi.mocked(loadDesktopUpdateMetadata).mockResolvedValue(release)
  vi.mocked(loadDesktopDownload).mockResolvedValue({ release, commands: 'curl --output package.deb https://example.org/package.deb\nsudo apt install -y ./package.deb', localCommands: 'install -m 644 package.deb /tmp/package.deb' })
})
afterEach(() => { vi.restoreAllMocks(); delete desktopWindow.__RUNLAB_DESKTOP__; delete desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ })

function native(version = '0.2.0-rc.3') {
  desktopWindow.__RUNLAB_DESKTOP__ = true
  desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ = {
    version: 1, getInfo: async () => ({ version, focused: true, visible: true }),
    notify: async () => {}, setActivity: async () => {}, subscribe: () => () => {},
  }
}

describe('native desktop update surfaces', () => {
  it('does nothing in ordinary browsers and safely handles old native clients', async () => {
    const { unmount } = render(<DesktopUpdateEntry />)
    expect(screen.queryByTestId('desktop-update-available')).toBeNull()
    expect(loadDesktopUpdateMetadata).not.toHaveBeenCalled()
    unmount()
    desktopWindow.__RUNLAB_DESKTOP__ = true
    render(<DesktopUpdateSettings />)
    expect(screen.getByRole('alert').textContent).toContain('older desktop client')
    expect((screen.getByTestId('desktop-check-update') as HTMLButtonElement).disabled).toBe(true)
  })
  it('offers only an actual newer release and opens the full safe modal on user action', async () => {
    native()
    render(<><textarea aria-label="Draft" defaultValue="Keep me" /><DesktopUpdateEntry /></>)
    const entry = await screen.findByTestId('desktop-update-available')
    expect(loadDesktopDownload).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(entry)
    await screen.findByTestId('copy-desktop-command')
    expect(screen.getByTestId('desktop-release-security').textContent).toContain('Unsigned')
    expect(screen.getByTestId('desktop-update-restart').textContent).toContain('choose Quit from the tray menu')
    expect(screen.getByTestId('desktop-update-restart').textContent).toContain('does not replace the running process')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep me')
  })
  it.each(['0.2.0-rc.4', '0.2.0-rc.5', '0.2.0'])('does not offer downgrade/same release for %s', async (version) => {
    native(version)
    render(<DesktopUpdateSettings />)
    await screen.findByText('No newer desktop package is published on this deployment.')
    expect(screen.queryByTestId('desktop-open-update')).toBeNull()
  })
  it('shows failed/malformed metadata honestly and allows a manual retry', async () => {
    native()
    vi.mocked(loadDesktopUpdateMetadata).mockRejectedValueOnce(new Error('Invalid release metadata'))
    render(<DesktopUpdateSettings />)
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid release metadata')
    expect(screen.queryByTestId('desktop-open-update')).toBeNull()
    fireEvent.click(screen.getByTestId('desktop-check-update'))
    await screen.findByTestId('desktop-open-update')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
  it('fails closed for an invalid installed version without fetching a package', async () => {
    native('unknown')
    render(<DesktopUpdateSettings />)
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid installed desktop version')
    expect(loadDesktopUpdateMetadata).not.toHaveBeenCalled()
  })
})
