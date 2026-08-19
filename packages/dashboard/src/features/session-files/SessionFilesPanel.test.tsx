import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirListEntry, DirListResult, FileContentsResult, TerminalCreateResult, TerminalKillResult } from '@agent-kernel/shared'

import { SessionFilesPanel, WorkspaceFileViewDialog } from './SessionFilesPanel.js'

const setPositionMock = vi.fn()
const revealLineInCenterMock = vi.fn()

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, language, options, onMount }: { value: string; language: string; options: { readOnly?: boolean; wordWrap?: string; fontSize?: number }; onMount?: (editor: { setPosition: typeof setPositionMock; revealLineInCenter: typeof revealLineInCenterMock }) => void }) => {
    onMount?.({ setPosition: setPositionMock, revealLineInCenter: revealLineInCenterMock })
    return <pre data-language={language} data-readonly={String(options.readOnly)} data-word-wrap={String(options.wordWrap)} data-font-size={String(options.fontSize)} data-testid="monaco-editor">{value}</pre>
  },
}))

vi.mock('react-arborist', () => ({
  Tree: ({ data, children, onActivate }: { data: TestTreeNode[]; children: (input: unknown) => JSX.Element; onActivate?: (node: { data: TestTreeNode }) => void }) => (
    <div data-testid="file-tree">
      {renderTreeRows(data, children, onActivate)}
    </div>
  ),
}))

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ totalCount, itemContent, ...props }: { totalCount: number; itemContent: (index: number) => JSX.Element }) => (
    <div {...props}>{Array.from({ length: totalCount }, (_, index) => <div key={index}>{itemContent(index)}</div>)}</div>
  ),
}))

const writeMock = vi.fn()
const writelnMock = vi.fn()
const inputListeners: Array<(data: string) => void> = []
const createObjectURLMock = vi.fn(() => 'blob:mock')
const revokeObjectURLMock = vi.fn()

vi.mock('@xterm/xterm', () => ({
  Terminal: class TerminalMock {
    cols = 100
    rows = 8
    write = writeMock
    writeln = writelnMock
    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    onData(listener: (data: string) => void): { dispose(): void } {
      inputListeners.push(listener)
      return { dispose() {} }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class FitAddonMock { fit(): void {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class SearchAddonMock {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class WebLinksAddonMock {} }))

type TestTreeNode = {
  id: string
  name: string
  path: string
  type: 'directory' | 'file'
  size?: number
  children?: TestTreeNode[]
}

function renderTreeRows(
  data: readonly TestTreeNode[],
  row: (input: unknown) => JSX.Element,
  onActivate?: (node: { data: TestTreeNode }) => void,
): JSX.Element[] {
  return data.flatMap((item) => {
    const rendered = row({
      style: {},
      node: {
        data: item,
        isSelected: false,
        activate: () => onActivate?.({ data: item }),
        toggle: vi.fn(),
      },
    })
    return [<div key={item.id}>{rendered}</div>, ...(item.children ? renderTreeRows(item.children, row, onActivate) : [])]
  })
}

describe('SessionFilesPanel', () => {
  beforeEach(() => {
    writeMock.mockClear()
    writelnMock.mockClear()
    setPositionMock.mockClear()
    revealLineInCenterMock.mockClear()
    inputListeners.length = 0
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } })
    vi.stubGlobal('URL', { ...URL, createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    createObjectURLMock.mockClear()
    revokeObjectURLMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads the session file tree and views text files read-only', async () => {
    const socket = makeSessionFilesSocket({
      file: { kind: 'text', content: 'hello', size: 5 },
      entries: [{ name: 'notes.txt', path: '/repo/notes.txt', type: 'file', size: 5 }],
    })

    render(<SessionFilesPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByText('notes.txt'))

    expect((await screen.findByTestId('monaco-editor')).textContent).toContain('hello')
    expect(screen.getByTestId('monaco-editor').getAttribute('data-readonly')).toBe('true')
    expect(screen.getByTestId('monaco-editor').getAttribute('data-font-size')).toBe('14')
    expect(socket.emitMock).toHaveBeenCalledWith('client:list_dirs', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', path: '/repo' }))
    expect(socket.emitMock).toHaveBeenCalledWith('workspace:read_binary', expect.objectContaining({ workspaceId: 'ws-1', path: '/repo/notes.txt', maxBytes: 1024 * 1024 }), expect.any(Function))
  })

  it('uses the configured file view font size', async () => {
    localStorage.setItem('ak-file-view-font-size', '4')
    const socket = makeSessionFilesSocket({
      file: { kind: 'text', content: 'hello', size: 5 },
      entries: [{ name: 'notes.txt', path: '/repo/notes.txt', type: 'file', size: 5 }],
    })

    render(<SessionFilesPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByText('notes.txt'))

    expect((await screen.findByTestId('monaco-editor')).getAttribute('data-font-size')).toBe('18')
  })

  it('shows large and binary files without loading full content into Monaco', async () => {
    const large = makeSessionFilesSocket({ file: { kind: 'too_large', content: 'visible', size: 2 * 1024 * 1024, truncated: true, error: 'EFBIG' } })
    const { unmount } = render(<SessionFilesPanel socket={large.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('README.md'))

    expect(await screen.findByText(/Large file view is capped/i)).toBeTruthy()
    expect(screen.getByTestId('monaco-editor').textContent).toContain('visible')
    unmount()

    const binary = makeSessionFilesSocket({ file: { kind: 'binary', size: 4096, error: 'EBINARY' } })
    render(<SessionFilesPanel socket={binary.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('README.md'))

    expect(await screen.findByText('Binary file cannot be viewed')).toBeTruthy()
    expect(screen.getByText(/This file is binary/i)).toBeTruthy()
    expect(screen.queryByTestId('monaco-editor')).toBeNull()
  })

  it('uses a full-height mobile file-view contract with reachable scrolling actions and close control', async () => {
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: 'hello', size: 5 } })
    render(<WorkspaceFileViewDialog open onOpenChange={() => {}} socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" target={{ path: '/repo/very/long/path/notes.txt' }} />)
    await screen.findByTestId('monaco-editor')
    const dialog = screen.getByTestId('session-file-view-dialog')
    expect(dialog.className).toContain('w-screen')
    expect(dialog.className).toContain('--ak-viewport-h')
    expect(dialog.className).toContain('grid-rows-[auto_minmax(0,1fr)]')
    expect(screen.getByTestId('session-file-view-actions').className).toContain('overflow-x-auto')
    expect(screen.getByTestId('session-file-view-close').className).toContain('h-11 w-11')
  })

  it('renders image files in the sidebar file view modal and supports view actions', async () => {
    const socket = makeSessionFilesSocket({
      file: { kind: 'image', content: 'aW1hZ2U=', size: 5, encoding: 'base64', mediaType: 'image/png' },
      entries: [{ name: 'image.png', path: '/repo/image.png', type: 'file', size: 5 }],
    })

    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByText('image.png'))

    const image = await screen.findByRole('img')
    expect(image.getAttribute('src')).toBe('data:image/png;base64,aW1hZ2U=')
    expect(screen.getByText('image/png')).toBeTruthy()
    expect(socket.emitMock).toHaveBeenCalledWith('client:list_dirs', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', path: '/repo' }))
    expect(socket.emitMock).toHaveBeenCalledWith('workspace:read_binary', expect.objectContaining({ workspaceId: 'ws-1', path: '/repo/image.png' }), expect.any(Function))

    fireEvent.click(screen.getByRole('button', { name: /copy path/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/repo/image.png')
    fireEvent.click(screen.getByRole('button', { name: /copy visible content/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('data:image/png;base64,aW1hZ2U=')
    fireEvent.click(screen.getByRole('button', { name: /download file/i }))
    expect(createObjectURLMock).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /refresh file/i }))
    await waitFor(() => expect(socket.emitMock).toHaveBeenCalledWith('workspace:read_binary', expect.objectContaining({ path: '/repo/image.png' }), expect.any(Function)))
    expect(socket.emitMock.mock.calls.filter(([event]) => event === 'workspace:read_binary')).toHaveLength(2)
  })

  it('downloads files from the tree and requests binary download content', async () => {
    const socket = makeSessionFilesSocket({
      file: { kind: 'binary', content: 'AAE=', size: 2, encoding: 'base64', mediaType: 'application/octet-stream' },
      entries: [{ name: 'archive.bin', path: '/repo/archive.bin', type: 'file', size: 2 }],
    })

    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByRole('button', { name: /download archive\.bin/i }))

    await waitFor(() => expect(createObjectURLMock).toHaveBeenCalled())
    expect(socket.emitMock).toHaveBeenCalledWith('workspace:read_binary', expect.objectContaining({ workspaceId: 'ws-1', path: '/repo/archive.bin', maxBytes: 100 * 1024 * 1024 }), expect.any(Function))
  })

  it('renders GIF files through the image viewer', async () => {
    const socket = makeSessionFilesSocket({
      file: { kind: 'image', content: 'R0lGODlh', size: 6, encoding: 'base64', mediaType: 'image/gif' },
      entries: [{ name: 'spin.gif', path: '/repo/spin.gif', type: 'file', size: 6 }],
    })

    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByText('spin.gif'))

    const image = await screen.findByRole('img')
    expect(image.getAttribute('src')).toBe('data:image/gif;base64,R0lGODlh')
    expect(screen.getByText('image/gif')).toBeTruthy()
  })

  it('renders PDF files in the file view modal when the browser has a PDF viewer', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: true })
    const socket = makeSessionFilesSocket({
      file: { kind: 'pdf', content: 'JVBERi0x', size: 8, encoding: 'base64', mediaType: 'application/pdf' },
      entries: [{ name: 'report.pdf', path: '/repo/report.pdf', type: 'file', size: 8 }],
    })

    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByText('report.pdf'))

    expect(await screen.findByTestId('session-file-pdf-fallback')).toBeTruthy()
    expect(createObjectURLMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open inline preview' }))
    const pdf = await screen.findByTestId('session-file-pdf-viewer')
    expect(pdf.getAttribute('src')).toBe('blob:mock')
    expect(createObjectURLMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/pdf' }))
    expect(pdf.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(pdf.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('shows a download-oriented PDF fallback without creating a Blob URL when the browser lacks a viewer', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: false })
    const socket = makeSessionFilesSocket({ file: { kind: 'pdf', content: 'JVBERi0x', size: 8, encoding: 'base64', mediaType: 'application/pdf' }, entries: [{ name: 'report.pdf', path: '/repo/report.pdf', type: 'file' }] })
    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('report.pdf'))
    expect(await screen.findByTestId('session-file-pdf-fallback')).toBeTruthy()
    expect(screen.getByText(/Use Download file/u)).toBeTruthy()
    expect(createObjectURLMock).not.toHaveBeenCalled()
  })

  it('opens Markdown files in rendered preview mode by default and can switch to source', async () => {
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: '# Title\n\n- item', size: 15 } })

    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByText('README.md'))

    const preview = await screen.findByTestId('session-file-markdown-preview')
    expect(preview.textContent).toContain('Title')
    expect(screen.queryByTestId('monaco-editor')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /show source/i }))
    expect((await screen.findByTestId('monaco-editor')).getAttribute('data-language')).toBe('markdown')

    fireEvent.click(screen.getByRole('button', { name: /show structured preview/i }))
    expect(await screen.findByTestId('session-file-markdown-preview')).toBeTruthy()
  })

  it('previews CSV as an inert virtualized table and switches to source', async () => {
    const socket = makeSessionFilesSocket({
      file: { kind: 'text', content: 'name,note,value\nAda,"hello, world",=1+1', size: 42 },
      entries: [{ name: 'people.csv', path: '/repo/people.csv', type: 'file', size: 42 }],
    })
    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('people.csv'))
    expect(await screen.findByTestId('session-file-table-preview')).toBeTruthy()
    expect(screen.getByText('hello, world')).toBeTruthy()
    expect(screen.getByText('=1+1')).toBeTruthy()
    expect(screen.queryByTestId('monaco-editor')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /show source/i }))
    expect((await screen.findByTestId('monaco-editor')).textContent).toContain('name,note,value')
  })

  it('previews JSONL records while retaining malformed-line diagnostics', async () => {
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: '{"ok":true}\ninvalid\n{"ok":false}', size: 34 }, entries: [{ name: 'events.jsonl', path: '/repo/events.jsonl', type: 'file' }] })
    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('events.jsonl'))
    expect(await screen.findByTestId('session-file-record-preview')).toBeTruthy()
    expect(screen.getByText(/Invalid JSON on Line 2/u)).toBeTruthy()
    expect(screen.getByText('true')).toBeTruthy()
    expect(screen.getByText('false')).toBeTruthy()
  })

  it('rejects XML entities in structured mode and keeps safe source available', async () => {
    const xml = '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: xml, size: xml.length }, entries: [{ name: 'unsafe.xml', path: '/repo/unsafe.xml', type: 'file' }] })
    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('unsafe.xml'))
    expect(await screen.findByText(/DOCTYPE and ENTITY declarations are disabled/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /show source/i }))
    expect((await screen.findByTestId('monaco-editor')).textContent).toContain('<!ENTITY')
  })

  it('previews logs without ANSI and filters levels', async () => {
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: '\u001b[31mERROR\u001b[0m failed\nINFO ready', size: 36 }, entries: [{ name: 'app.log', path: '/repo/app.log', type: 'file' }] })
    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('app.log'))
    expect(await screen.findByTestId('session-file-log-preview')).toBeTruthy()
    expect(screen.getByText('ERROR failed')).toBeTruthy()
    expect(document.body.textContent).not.toContain('\u001b')
    fireEvent.click(screen.getByRole('button', { name: 'error' }))
    expect(screen.queryByText('ERROR failed')).toBeNull()
    expect(screen.getByText('INFO ready')).toBeTruthy()
  })

  it('previews patch additions and deletions with semantic rows', async () => {
    const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new'
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: patch, size: patch.length }, entries: [{ name: 'change.patch', path: '/repo/change.patch', type: 'file' }] })
    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('change.patch'))
    const preview = await screen.findByTestId('session-file-diff-preview')
    expect(screen.getByText('+new').parentElement?.className).toContain('text-emerald')
    expect(screen.getByText('-old').parentElement?.className).toContain('text-red')
    expect(preview.textContent).toContain('@@ -1 +1 @@')
  })

  it('does not execute Mermaid or expose unsafe Markdown links', async () => {
    const markdown = '[bad](javascript:alert(1))\n\n![remote](https://example.invalid/tracker.png)\n\n```mermaid\ngraph TD; A-->B\n```'
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: markdown, size: markdown.length } })
    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)
    fireEvent.click(await screen.findByText('README.md'))
    const preview = await screen.findByTestId('session-file-markdown-preview')
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
    expect(preview.textContent).toContain('graph TD; A-->B')
    expect(preview.textContent).toContain('[Image blocked in preview: remote]')
    expect(preview.querySelector('img')).toBeNull()
    expect(preview.querySelector('svg')).toBeNull()
  })

  it('toggles word wrap for text views in the sidebar modal', async () => {
    const socket = makeSessionFilesSocket({
      file: { kind: 'text', content: 'long line', size: 9 },
      entries: [{ name: 'notes.txt', path: '/repo/notes.txt', type: 'file', size: 9 }],
    })

    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByText('notes.txt'))
    expect((await screen.findByTestId('monaco-editor')).getAttribute('data-word-wrap')).toBe('on')
    fireEvent.click(screen.getByRole('button', { name: /toggle word wrap/i }))
    expect(screen.getByTestId('monaco-editor').getAttribute('data-word-wrap')).toBe('off')
  })

  it('adjusts file view modal font size only for the current modal', async () => {
    localStorage.setItem('ak-file-view-font-size', '2')
    const socket = makeSessionFilesSocket({
      file: { kind: 'text', content: 'long line', size: 9 },
      entries: [{ name: 'notes.txt', path: '/repo/notes.txt', type: 'file', size: 9 }],
    })

    render(<SessionFilesPanel mode="sidebar" socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(await screen.findByText('notes.txt'))
    expect((await screen.findByTestId('monaco-editor')).getAttribute('data-font-size')).toBe('14')

    fireEvent.click(screen.getByRole('button', { name: /increase file view font size/i }))
    expect(screen.getByTestId('monaco-editor').getAttribute('data-font-size')).toBe('16')
    fireEvent.click(screen.getByRole('button', { name: /decrease file view font size/i }))
    fireEvent.click(screen.getByRole('button', { name: /decrease file view font size/i }))
    expect(screen.getByTestId('monaco-editor').getAttribute('data-font-size')).toBe('12')
    expect(localStorage.getItem('ak-file-view-font-size')).toBe('2')
  })

  it('opens a targeted file view at the requested line and column', async () => {
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: 'a\nb\nc', size: 5 } })

    render(<WorkspaceFileViewDialog open onOpenChange={() => {}} socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo/pkg" target={{ path: 'source.ts', line: 3, column: 2 }} />)

    expect((await screen.findByTestId('monaco-editor')).textContent).toContain('a\nb\nc')
    expect(socket.emitMock).toHaveBeenCalledWith('workspace:read_binary', expect.objectContaining({ path: 'source.ts', cwd: '/repo/pkg' }), expect.any(Function))
    expect(setPositionMock).toHaveBeenCalledWith({ lineNumber: 3, column: 2 })
    expect(revealLineInCenterMock).toHaveBeenCalledWith(3)
  })

  it('shows actionable diagnostics for missing files', async () => {
    const socket = makeSessionFilesSocket({ file: { kind: 'not_found', size: 0, error: 'ENOENT: no such file or directory' } })

    render(<WorkspaceFileViewDialog open onOpenChange={() => {}} socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" target={{ path: '/repo/missing.md' }} />)

    expect(await screen.findByText('File not found')).toBeTruthy()
    expect(screen.getByText(/deleted, moved, or generated in a different workspace/i)).toBeTruthy()
  })

  it('starts a session terminal, forwards input, renders output, and kills on close', async () => {
    const socket = makeSessionFilesSocket({ file: { kind: 'text', content: '', size: 0 } })
    render(<SessionFilesPanel socket={socket.asDashboardSocket()} workspaceId="ws-1" sessionId="sess-1" cwd="/repo" />)

    fireEvent.click(screen.getByRole('button', { name: /start/i }))

    await waitFor(() => expect(socket.emitMock).toHaveBeenCalledWith('terminal:create', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', cwd: '/repo' }), expect.any(Function)))
    await waitFor(() => expect(inputListeners.length).toBeGreaterThan(0))
    inputListeners.at(-1)?.('echo ok\r')
    expect(socket.emitMock).toHaveBeenCalledWith('terminal:input', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', terminalId: 'term-1', data: 'echo ok\r' }))

    socket.serverEmit('server:terminal_output', { workspaceId: 'ws-1', sessionId: 'sess-1', terminalId: 'term-1', data: 'ok\r\n' })
    expect(writeMock).toHaveBeenCalledWith('ok\r\n')

    fireEvent.click(screen.getByRole('button', { name: /kill/i }))
    expect(socket.emitMock).toHaveBeenCalledWith('terminal:kill', expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', terminalId: 'term-1' }), expect.any(Function))
  })
})

function makeSessionFilesSocket(input: {
  file: Pick<FileContentsResult, 'kind' | 'content' | 'size' | 'truncated' | 'error' | 'encoding' | 'mediaType'>
  entries?: DirListEntry[]
}) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const emitMock = vi.fn((event: string, payload: Record<string, unknown>, ack?: (payload: unknown) => void) => {
    if (event === 'client:list_dirs') {
      queueMicrotask(() => serverEmit('server:dir_list', dirList(String(payload.requestId), input.entries)))
    }
    if (event === 'workspace:read_binary') {
      // File reads flow through workspace:read_binary since the workspace-
      // exec refactor. Translate the test's FileContentsResult stub back
      // to the ReadBinary envelope so classifyReadBinaryResult() lands on
      // the same kind.
      queueMicrotask(() => ack?.(readBinaryFromFixture(String(payload.requestId), input.file)))
    }
    if (event === 'terminal:create') {
      queueMicrotask(() => ack?.({ requestId: payload.requestId, workspaceId: 'ws-1', sessionId: 'sess-1', terminalId: 'term-1', cwd: '/repo' } satisfies TerminalCreateResult))
    }
    if (event === 'terminal:kill') {
      queueMicrotask(() => ack?.({ requestId: payload.requestId, workspaceId: 'ws-1', sessionId: 'sess-1', terminalId: 'term-1', killed: true } satisfies TerminalKillResult))
    }
    return undefined
  })
  function serverEmit(event: string, payload: unknown): void {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }
  return {
    emitMock,
    serverEmit,
    asDashboardSocket() {
      return {
        on(event: string, handler: (payload: unknown) => void) {
          const set = handlers.get(event) ?? new Set()
          set.add(handler)
          handlers.set(event, set)
        },
        off(event: string, handler: (payload: unknown) => void) {
          handlers.get(event)?.delete(handler)
        },
        emit: emitMock,
      } as never
    },
  }
}

function readBinaryFromFixture(requestId: string, file: Pick<FileContentsResult, 'kind' | 'content' | 'size' | 'truncated' | 'error' | 'encoding' | 'mediaType'>) {
  if (file.kind === 'not_found') {
    return { requestId, base64: '', mime: 'application/octet-stream', size: file.size ?? 0, error: { code: 'ENOENT', message: file.error ?? 'not found' } }
  }
  // 'too_large' or 'binary' with an inline error is still a successful read
  // in the workspace:read_binary contract — the ReadBinary channel truncates
  // rather than failing, and the viewer surfaces "capped" from res.truncated.
  const isTruncatedTextFixture = file.kind === 'too_large' && file.content !== undefined
  const isBinaryFixture = file.kind === 'binary'
  if (file.error && !isTruncatedTextFixture && !isBinaryFixture) {
    return { requestId, base64: '', mime: 'application/octet-stream', size: file.size ?? 0, error: { code: 'EACCES', message: file.error } }
  }
  const mime = file.mediaType
    ?? (file.kind === 'image' ? 'image/png' : file.kind === 'pdf' ? 'application/pdf' : file.kind === 'binary' ? 'application/octet-stream' : 'text/plain')
  const base64 = file.encoding === 'base64'
    ? (file.content ?? '')
    : btoa(unescape(encodeURIComponent(file.content ?? '')))
  const truncated = file.truncated || isTruncatedTextFixture ? { truncated: { maxBytes: file.size ?? 0 } } : {}
  return { requestId, base64, mime, size: file.size ?? base64.length, ...truncated }
}

function dirList(requestId: string, overrideEntries?: DirListEntry[]): DirListResult {
  const entries: DirListEntry[] = overrideEntries ?? [
    { name: 'src', path: '/repo/src', type: 'directory' },
    { name: 'README.md', path: '/repo/README.md', type: 'file', size: 7 },
  ]
  return { requestId, workspaceId: 'ws-1', path: '/repo', roots: ['/repo'], entries }
}

function fileContents(requestId: string, path: string, file: Pick<FileContentsResult, 'kind' | 'content' | 'size' | 'truncated' | 'error' | 'encoding' | 'mediaType'>): FileContentsResult {
  return { requestId, workspaceId: 'ws-1', path, ...file }
}
