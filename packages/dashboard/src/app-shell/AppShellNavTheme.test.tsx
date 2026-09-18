import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AppShellNav } from './AppShellNav.js'

describe('AppShellNav theme-aware collapsed surfaces', () => {
  it('uses the theme-aware fused topbar shell when collapsed session content is present', () => {
    render(
      <AppShellNav
        section="agent"
        onSelect={() => {}}
        onOpenSettings={() => {}}
        collapsed
        collapsedContent={<span data-testid="collapsed-session-header">Session A</span>}
        onCollapse={() => {}}
        onExpand={() => {}}
      />,
    )

    const nav = screen.getByTestId('app-shell-nav')
    expect(nav.className).toContain('ak-fused-topbar-shell')
    expect(nav.className).not.toContain('ak-global-topbar')
    expect(nav.className).toContain('h-14')
  })

  it('keeps the minimal collapsed brand on the dark global topbar', () => {
    render(
      <AppShellNav
        section="agent"
        onSelect={() => {}}
        onOpenSettings={() => {}}
        collapsed
        onCollapse={() => {}}
        onExpand={() => {}}
      />,
    )

    const nav = screen.getByTestId('app-shell-nav')
    expect(nav.className).toContain('ak-global-topbar')
    expect(nav.className).not.toContain('ak-fused-topbar-shell')
  })
})
