import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '../i18n/index.js'
import { AppShellNav } from './AppShellNav.js'

function renderNav(overrides: Partial<Parameters<typeof AppShellNav>[0]> = {}): void {
  render(
    <AppShellNav
      section="agent"
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
    for (const id of ['agent', 'operations', 'artifacts', 'pipeline', 'docs']) {
      expect(screen.getByTestId(`app-shell-nav-${id}`)).toBeTruthy()
    }
    expect(screen.queryByTestId('app-shell-nav-settings')).toBeNull()
    const active = screen.getByTestId('app-shell-nav-agent')
    expect(active.getAttribute('aria-current')).toBe('page')
    expect(active.className).toContain('text-foreground')
    expect(active.className).not.toContain('text-primary')
    expect(screen.queryByTestId('app-shell-open-evaluation')).toBeNull()
  })

  it('opens Evaluation only when the Runtime advertises a public URL', () => {
    renderNav({ evaluationUrl: 'https://evaluation.example.test' })
    expect(screen.getByTestId('app-shell-open-evaluation').getAttribute('href')).toBe('https://evaluation.example.test')
    expect(screen.getByTestId('app-shell-open-evaluation').getAttribute('target')).toBe('_blank')
  })

  it('offers web users an in-app dialog trigger instead of a navigation link', () => {
    renderNav()
    expect(screen.getByLabelText('Agent RunLab').querySelector('img')?.getAttribute('src')).toBe('/icons/octopus-web.svg')
    const trigger = screen.getByTestId('app-shell-download-desktop')
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.className).toContain('hidden')
    expect(trigger.className).toContain('sm:inline-flex')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('href')).toBeNull()
    expect(trigger.getAttribute('target')).toBeNull()
  })

  it('hides browser installation entry inside the installed desktop', () => {
    Object.defineProperty(window, '__RUNLAB_DESKTOP__', { value: true, configurable: true })
    try {
      renderNav()
      expect(screen.queryByTestId('app-shell-download-desktop')).toBeNull()
      expect(screen.getByLabelText('Agent RunLab').querySelector('img')?.getAttribute('src')).toBe('/icons/octopus-desktop.svg')
    } finally {
      delete (window as Window & { __RUNLAB_DESKTOP__?: boolean }).__RUNLAB_DESKTOP__
    }
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
    fireEvent.click(screen.getByTestId('app-shell-nav-artifacts'))
    expect(onSelect).toHaveBeenCalledWith('artifacts')
  })

  it('settings icon fires onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    renderNav({ onOpenSettings })
    fireEvent.click(screen.getByTestId('app-shell-nav-settings-icon'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('calls onCollapse and keeps a compact topbar while collapsed', () => {
    const onCollapse = vi.fn()
    const { rerender } = render(
      <AppShellNav
        section="agent"
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
        section="agent"
        onSelect={() => {}}
        onOpenSettings={() => {}}
        collapsed
        onCollapse={onCollapse}
        onExpand={() => {}}
        collapsedContent={<span data-testid="collapsed-session-header">Session A</span>}
      />,
    )
    expect(screen.getByTestId('app-shell-nav').getAttribute('data-collapsed')).toBe('true')
    expect(screen.getByTestId('app-shell-nav').className).toContain('ak-fused-topbar-shell')
    expect(screen.getByTestId('app-shell-nav').className).toContain('px-2')
    expect(screen.getByTestId('app-shell-nav').className).toContain('py-1.5')
    expect(screen.getByTestId('collapsed-session-header').textContent).toBe('Session A')
    expect(screen.queryByTestId('app-shell-nav-agent')).toBeNull()
  })

  it('keeps a minimal brand and expand control when collapsed without session content', () => {
    const onExpand = vi.fn()
    renderNav({ collapsed: true, onExpand })

    expect(screen.getByTestId('app-shell-nav').getAttribute('data-collapsed')).toBe('true')
    expect(screen.getByLabelText('Agent RunLab')).toBeTruthy()
    fireEvent.click(screen.getByTestId('app-shell-nav-expand'))
    expect(onExpand).toHaveBeenCalledOnce()
  })

  it('keeps collapse as the rightmost global control', () => {
    renderNav({ connectionStatus: <span data-testid="connection-status">Connected</span> })
    const settings = screen.getByTestId('app-shell-nav-settings-icon')
    const status = screen.getByTestId('connection-status')
    const collapse = screen.getByTestId('app-shell-nav-collapse')
    expect(settings.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(status.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('uses a compact global navigation bar and controls', () => {
    renderNav()
    expect(screen.getByTestId('app-shell-nav').className).toContain('h-10')
    expect(screen.getByTestId('app-shell-nav').className).toContain('ak-global-topbar')
    expect(screen.getByTestId('app-shell-nav').className).not.toContain('bg-background/80')
    expect(screen.getByTestId('app-shell-nav-agent').className).toContain('h-8')
    expect(screen.getByTestId('app-shell-nav-settings-icon').className).toContain('h-8')
  })

  it('does not render the inspector collapse control in the global nav', () => {
    renderNav()
    expect(screen.queryByTestId('app-shell-nav-inspector-icon')).toBeNull()
  })
})
