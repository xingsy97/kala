import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocsPage } from './DocsPage.js'
import { i18n } from '../../i18n/index.js'

describe('DocsPage', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads docs dynamically and renders the selected markdown body as-is', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/docs/index') {
        return new Response(JSON.stringify({
        root: 'docs',
        docs: [
          { path: 'context-compaction.md', title: 'Context Compaction', size: 128, updatedAt: '2026-07-11T00:00:00.000Z' },
          { path: 'protocol/wire-protocol.md', title: 'Wire Protocol', size: 512, updatedAt: '2026-07-11T00:02:00.000Z' },
          { path: 'domain-knowledge/swe-bench.md', title: 'SWE-bench', size: 256, updatedAt: '2026-07-11T00:01:00.000Z' },
        ],
        }), { status: 200 })
      }
      if (url === '/docs/content?path=context-compaction.md') {
        return new Response(JSON.stringify({
        path: 'context-compaction.md',
        title: 'Context Compaction',
        updatedAt: '2026-07-11T00:00:00.000Z',
        body: [
          '# Context Compaction',
          '',
          '- Preserve tool results before summarizing [1].',
          '',
          '| Phase | Owner |',
          '| --- | --- |',
          '| Compact | Host |',
          '',
          '```ts',
          'compact({ force: true })',
          '```',
          '',
          '`compact()` stays literal.',
          '',
          '## References',
          '',
          '[1] https://example.org/reference',
        ].join('\n'),
        }), { status: 200 })
      }
      if (url === '/docs/content?path=domain-knowledge%2Fswe-bench.md') {
        return new Response(JSON.stringify({
        path: 'domain-knowledge/swe-bench.md',
        title: 'SWE-bench',
        updatedAt: '2026-07-11T00:01:00.000Z',
        body: '# SWE-bench\n\nOfficial harness applies patches and runs repository tests.',
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: `unexpected docs request: ${url}` }), { status: 404 })
    })

    render(<DocsPage />)
    expect(screen.queryByText(i18n.t('docs.page.subtitle'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.aboutLabel', { label: i18n.t('docs.page.title') }) }))
    expect(screen.getByRole('tooltip').textContent).toBe(i18n.t('docs.page.subtitle'))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(fetchMock).toHaveBeenCalledWith('/docs/index', { cache: 'no-store' })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/docs/content?path=context-compaction.md', { cache: 'no-store' })
    })
    await screen.findByRole('heading', { name: 'Context Compaction' }, { timeout: 5_000 })
    expect(screen.getByText(/Preserve tool results before summarizing/)).toBeTruthy()
    const citation = screen.getAllByRole('link', { name: '[1]' })[0]!
    expect(citation.getAttribute('href')).toBe('#ref-1')
    const reference = screen.getByRole('link', { name: 'https://example.org/reference' })
    expect(reference.getAttribute('href')).toBe('https://example.org/reference')
    expect(reference.closest('p')?.id).toBe('ref-1')
    const list = screen.getByTestId('docs-list')
    expect(screen.getByTestId('docs-tree-folder-domain-knowledge')).toBeTruthy()
    expect(screen.getByTestId('docs-tree-folder-protocol')).toBeTruthy()
    expect(screen.getByTestId('docs-sidebar-panel')).toBeTruthy()
    expect(screen.getByTestId('docs-content-panel')).toBeTruthy()
    const toggleAll = screen.getByTestId('docs-tree-toggle-all')
    expect(toggleAll.textContent ?? '').toContain('Collapse all')
    fireEvent.click(toggleAll)
    expect(within(list).queryByText('Wire Protocol')).toBeNull()
    expect(toggleAll.textContent ?? '').toContain('Expand all')
    fireEvent.click(toggleAll)
    expect(within(list).getByText('Wire Protocol')).toBeTruthy()
    expect(toggleAll.textContent ?? '').toContain('Collapse all')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Documentation table' }).hasAttribute('tabindex')).toBe(false)
    expect(screen.getByRole('columnheader', { name: 'Phase' }).getAttribute('scope')).toBe('col')
    expect(screen.getByText('Phase')).toBeTruthy()
    const docsMarkdown = screen.getByTestId('docs-markdown')
    expect(docsMarkdown.className).toContain('ak-markdown-body')
    expect(docsMarkdown.className).toContain('[&_h1]:text-2xl')
    expect(docsMarkdown.textContent).toContain('compact({ force: true })')
    expect(screen.getByText('compact()')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Search docs'), { target: { value: 'swe' } })
    expect(within(list).queryByText('Context Compaction')).toBeNull()
    fireEvent.click(within(list).getByText('SWE-bench'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/docs/content?path=domain-knowledge%2Fswe-bench.md', { cache: 'no-store' })
    })
    await screen.findByRole('heading', { name: 'SWE-bench' })
    expect(screen.getByText('Official harness applies patches and runs repository tests.')).toBeTruthy()
  })
})
