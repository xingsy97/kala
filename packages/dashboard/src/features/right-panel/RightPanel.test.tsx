import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RightPanel } from './RightPanel.js'

describe('RightPanel', () => {
  it('defaults through the selected inspector tab, switches without unmounting content, and collapses', () => {
    const onTabChange = vi.fn()
    const onCollapse = vi.fn()
    const { rerender } = render(<RightPanel activeTab="inspector" onTabChange={onTabChange} onCollapse={onCollapse} files={<div>files body</div>} git={<div>git body</div>} inspector={<div>inspector body</div>} terminal={<div>terminal body</div>} />)

    const tablist = screen.getByRole('tablist', { name: 'Workspace tools' })
    expect(tablist.className).toContain('bg-muted/20')
    expect(tablist.className).toContain('overflow-hidden')
    expect(screen.getByTestId('right-panel-tabs').className).toContain('min-w-0')
    const inspectorTab = screen.getByTestId('right-panel-inspector-tab')
    expect(inspectorTab.getAttribute('aria-selected')).toBe('true')
    expect(inspectorTab.className).toContain('bg-accent')
    expect(inspectorTab.className).not.toContain('border-b-2')
    expect(inspectorTab.className).toContain('w-full')
    expect(screen.getByTestId('right-panel-collapse').className).toContain('h-10')
    expect(screen.getByText('terminal body')).toBeTruthy()
    expect(screen.getByTestId('right-panel-terminal-content').classList.contains('hidden')).toBe(true)
    expect(screen.getByTestId('right-panel-inspector-content').classList.contains('hidden')).toBe(false)
    fireEvent.click(screen.getByTestId('right-panel-terminal-tab'))
    expect(onTabChange).toHaveBeenCalledWith('terminal')

    rerender(<RightPanel activeTab="terminal" onTabChange={onTabChange} onCollapse={onCollapse} files={<div>files body</div>} git={<div>git body</div>} inspector={<div>inspector body</div>} terminal={<div>terminal body</div>} />)
    expect(screen.getByTestId('right-panel-terminal-tab').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('right-panel-terminal-content').classList.contains('hidden')).toBe(false)
    expect(screen.getByTestId('right-panel-inspector-content').classList.contains('hidden')).toBe(true)
    expect(screen.getByText('inspector body')).toBeTruthy()
    fireEvent.click(screen.getByTestId('right-panel-files-tab'))
    expect(onTabChange).toHaveBeenCalledWith('files')
    fireEvent.click(screen.getByTestId('right-panel-git-tab'))
    expect(onTabChange).toHaveBeenCalledWith('git')
    fireEvent.click(screen.getByTestId('right-panel-collapse'))
    expect(onCollapse).toHaveBeenCalledOnce()
  })
})
