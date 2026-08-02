import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '../i18n/index.js'
import { AppShellNav } from './AppShellNav.js'

function renderNav(overrides: Partial<Parameters<typeof AppShellNav>[0]> = {}): void {
  render(
    <AppShellNav
      section="benchmarks"
      onSelect={() => {}}
      onOpenSettings={() => {}}
      collapsed={false}
      onCollapse={() => {}}
      onExpand={() => {}}
      {...overrides}
    />,
  )
}

describe('AppShellNav', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders nav tabs and marks the active section', () => {
    renderNav()
    for (const id of ['agent', 'benchmarks', 'operations', 'artifacts', 'pipeline', 'docs']) {
      expect(screen.getByTestId(`app-shell-nav-${id}`)).toBeTruthy()
    }
    expect(screen.getByTestId('app-shell-nav-benchmarks').textContent).toContain('Benchmarks')
    expect(screen.getByTestId('app-shell-nav-benchmarks').textContent).not.toContain('评测')
    expect(screen.queryByTestId('app-shell-nav-settings')).toBeNull()
    expect(screen.getByTestId('app-shell-nav-benchmarks').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('app-shell-nav-agent').getAttribute('aria-current')).toBeNull()
  })

  it('hides Benchmarks when the authoritative capability is disabled', () => {
    renderNav({ capabilities: { agent: true, benchmarks: false, evaluations: false }, section: 'agent' })
    expect(screen.queryByTestId('app-shell-nav-benchmarks')).toBeNull()
    expect(screen.getByTestId('app-shell-nav-agent')).toBeTruthy()
  })

  it('shows the authenticated account and signs out from the account menu', () => {
    const onSignOut = vi.fn()
    renderNav({
      section: 'agent',
      account: { displayName: 'RunLab Demo', email: 'runlab-demo@example.test', initials: 'RD' },
      onSignOut,
    })
    fireEvent.click(screen.getByTestId('account-menu-trigger'))
    expect(screen.getByTestId('account-identity-summary').textContent).toContain('RunLab Demo')
    expect(screen.getByTestId('account-identity-summary').textContent).toContain('runlab-demo@example.test')
    const form = screen.getByTestId('account-sign-out').closest('form')
    expect(form?.method).toContain('post')
    expect(form?.getAttribute('action')).toBe('/auth/logout')
    fireEvent.submit(form!)
    expect(onSignOut).not.toHaveBeenCalled()
    fireEvent(window, new PageTransitionEvent('pagehide'))
    expect(onSignOut).toHaveBeenCalledOnce()
  })

  it('does not unmount the native logout form before navigation commits', () => {
    const onSignOut = vi.fn()
    renderNav({ section: 'agent', account: { displayName: 'Demo', initials: 'D' }, onSignOut })
    const form = screen.getByTestId('account-sign-out').closest('form')!
    fireEvent.submit(form)
    expect(form.isConnected).toBe(true)
    expect(screen.getByTestId('account-sign-out')).toBeTruthy()
    expect(onSignOut).not.toHaveBeenCalled()
  })

  it('opens account details from the account menu', () => {
    const onOpenAccount = vi.fn()
    renderNav({ section: 'agent', account: { displayName: 'Demo', initials: 'D' }, onOpenAccount })
    fireEvent.click(screen.getByTestId('account-menu-trigger'))
    fireEvent.click(screen.getByTestId('account-details'))
    expect(onOpenAccount).toHaveBeenCalledOnce()
  })

  it('does not render a fake account trigger without an authenticated identity', () => {
    renderNav({ section: 'agent' })
    expect(screen.queryByTestId('account-menu')).toBeNull()
  })

  it('invokes onSelect when a tab is clicked', () => {
    const onSelect = vi.fn()
    renderNav({ section: 'agent', onSelect })
    fireEvent.click(screen.getByTestId('app-shell-nav-benchmarks'))
    expect(onSelect).toHaveBeenCalledWith('benchmarks')
  })

  it('localizes the benchmark tab label in Chinese', async () => {
    await i18n.changeLanguage('zh')
    renderNav()

    expect(screen.getByTestId('app-shell-nav-benchmarks').textContent).toContain('评测')
    expect(screen.getByTestId('app-shell-nav-benchmarks').textContent).not.toContain('Benchmarks')
  })

  it('settings icon fires onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    renderNav({ onOpenSettings })
    fireEvent.click(screen.getByTestId('app-shell-nav-settings-icon'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('calls onCollapse and renders nothing while collapsed', () => {
    const onCollapse = vi.fn()
    const { rerender } = render(
      <AppShellNav
        section="benchmarks"
        onSelect={() => {}}
        onOpenSettings={() => {}}
        collapsed={false}
        onCollapse={onCollapse}
        onExpand={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('app-shell-nav-collapse'))
    expect(onCollapse).toHaveBeenCalledTimes(1)

    rerender(
      <AppShellNav
        section="benchmarks"
        onSelect={() => {}}
        onOpenSettings={() => {}}
        collapsed
        onCollapse={onCollapse}
        onExpand={() => {}}
      />,
    )
    expect(screen.queryByTestId('app-shell-nav')).toBeNull()
    expect(screen.queryByTestId('app-shell-nav-benchmarks')).toBeNull()
  })

  it('keeps collapse as the rightmost global control', () => {
    renderNav({ connectionStatus: <span data-testid="connection-status">Connected</span> })
    const settings = screen.getByTestId('app-shell-nav-settings-icon')
    const status = screen.getByTestId('connection-status')
    const collapse = screen.getByTestId('app-shell-nav-collapse')
    expect(settings.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(status.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not render the inspector collapse control in the global nav', () => {
    renderNav()
    expect(screen.queryByTestId('app-shell-nav-inspector-icon')).toBeNull()
  })
})
