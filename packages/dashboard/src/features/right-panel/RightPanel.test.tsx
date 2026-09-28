import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RightPanel } from './RightPanel.js'

describe('RightPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('defaults through the selected inspector tab, switches without unmounting content, and collapses', () => {
    const onTabChange = vi.fn()
    const onCollapse = vi.fn()
    const { rerender } = render(<RightPanel activeTab="inspector" onTabChange={onTabChange} onCollapse={onCollapse} files={<div>files body</div>} git={<div>git body</div>} inspector={<div>inspector body</div>} terminal={<div>terminal body</div>} />)

    const tablist = screen.getByRole('tablist', { name: 'Workspace tools' })
    expect(tablist.parentElement?.className).toContain('bg-card/70')
    expect(tablist.parentElement?.className).toContain('overflow-hidden')
    expect(tablist.contains(screen.getByTestId('right-panel-collapse'))).toBe(false)
    expect(screen.getByTestId('right-panel-tabs').className).toContain('min-w-0')
    const inspectorTab = screen.getByTestId('right-panel-inspector-tab')
    expect(inspectorTab.getAttribute('aria-selected')).toBe('true')
    expect(inspectorTab.className).toContain('bg-card')
    expect(inspectorTab.className).not.toContain('border-b-2')
    expect(inspectorTab.className).toContain('w-full')
    expect(screen.getByTestId('right-panel-collapse').className).toContain('h-11')
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

  it('switches all tab labels to icons when their natural width does not fit', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'right-panel-tabs' ? 180 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.className.includes('invisible') ? 420 : 0
    })
    vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void { this.callback([], this as unknown as ResizeObserver) }
      disconnect(): void {}
      unobserve(): void {}
    })

    render(<RightPanel activeTab="files" onTabChange={() => {}} onCollapse={() => {}} files={null} git={null} terminal={null} inspector={null} />)

    await waitFor(() => expect(screen.getByTestId('right-panel-tabs').getAttribute('data-labels-visible')).toBe('false'))
    expect(screen.getByTestId('right-panel-terminal-tab').textContent).toBe('')
    expect(screen.getByTestId('right-panel-terminal-tab').getAttribute('aria-label')).toBe('Terminal')
    expect(screen.getByTestId('right-panel-terminal-tab').getAttribute('title')).toBe('Terminal')
  })
})
