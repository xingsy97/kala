import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Editor from '@monaco-editor/react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Check, ChevronDown, ChevronRight, Copy, Download, File, Folder, Loader2, Minus, Play, Plus, RefreshCw, SquareTerminal, WrapText, X } from 'lucide-react'
import { Tree, type NodeApi } from 'react-arborist'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Socket } from 'socket.io-client'

import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  DirListEntry,
  DirListResult,
  FileContentsResult,
  ServerTerminalExit,
  ServerTerminalOutput,
  TerminalCreateResult,
  TerminalKillResult,
} from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { DEFAULT_FILE_VIEW_FONT_SIZE, PREF_FILE_VIEW_FONT_SIZE, useNumberPref } from '../../lib/prefs.js'
import { workspaceReadBinary } from '../../lib/workspace-exec.js'
import { notify } from '../../notify.js'
import type { WorkspaceFileTarget } from '../chat/ChatPanel.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import { downloadFilename, fileResultDownloadBlob, saveBlob } from './file-download.js'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

const FILE_VIEW_FONT_SIZE_PX = [10, 12, 14, 16, 18] as const
const FILE_PREVIEW_MAX_BYTES = 1024 * 1024
const FILE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024

type FileNode = {
  id: string
  name: string
  path: string
  type: 'directory' | 'file'
  size?: number
  children?: FileNode[]
  loaded?: boolean
}

export function WorkspaceFileViewDialog({
  open,
  onOpenChange,
  socket,
  workspaceId,
  sessionId,
  cwd,
  path,
  target,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  socket: DashboardSocket | null
  workspaceId?: string
  sessionId?: string
  cwd?: string
  path?: string | null
  target?: WorkspaceFileTarget | null
}): JSX.Element {
  const [viewer, setViewer] = useState<FileViewState>({ kind: 'empty' })
  const [wordWrap, setWordWrap] = useState(true)
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState<'path' | 'content' | null>(null)
  const [fontSizeDelta, setFontSizeDelta] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const viewTarget = target ?? (path ? { path } : null)
  const viewPath = viewTarget?.path
  const effectiveFontSize = useFileViewFontSize(fontSizeDelta)

  const viewFile = useCallback(async (): Promise<void> => {
    if (!open || !socket || !workspaceId || !viewPath) return
    setViewer({ kind: 'loading', path: viewPath })
    const result = await requestFile(socket, workspaceId, sessionId, viewPath, { cwd })
    setViewer(fileResultToViewState(result))
  }, [cwd, open, sessionId, socket, viewPath, workspaceId])

  useEffect(() => {
    if (!open) return
    setFontSizeDelta(0)
    setMarkdownMode('preview')
    if (!viewPath) {
      setViewer({ kind: 'empty' })
      return
    }
    void viewFile()
  }, [open, viewPath, viewFile])

  const copyView = useCallback(async (target: 'path' | 'content'): Promise<void> => {
    const text = target === 'path' ? viewPath ?? viewerPath(viewer) : copyableViewerContent(viewer)
    if (!text) return
    await navigator.clipboard?.writeText(text)
    setCopied(target)
    window.setTimeout(() => setCopied((current) => current === target ? null : current), 1200)
  }, [viewPath, viewer])

  const downloadView = useCallback(async (): Promise<void> => {
    const targetPath = viewPath ?? viewerPath(viewer)
    if (!targetPath || !socket || !workspaceId) return
    setDownloading(true)
    try {
      await downloadWorkspaceFile(socket, workspaceId, sessionId, targetPath, viewer, cwd)
    } finally {
      setDownloading(false)
    }
  }, [cwd, sessionId, socket, viewPath, viewer, workspaceId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[96vw] max-w-[min(1100px,96vw)] gap-0 overflow-hidden p-0" data-testid="session-file-view-dialog">
        <DialogHeader className="border-b border-border px-3 py-2.5 pr-10 sm:px-4">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <Button variant="ghost" size="icon" className="h-6 w-6 flex-none" disabled={!viewPath && !viewerPath(viewer)} onClick={() => void copyView('path')} title="Copy path" aria-label="Copy path">
                  {copied === 'path' ? <Check className="h-3.5 w-3.5" /> : <File className="h-3.5 w-3.5" />}
                </Button>
                <DialogTitle className="min-w-0 truncate font-mono text-xs font-medium leading-5">{viewerTitle(viewer, viewPath)}</DialogTitle>
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                {viewerMeta(viewer).map((item) => <span key={item}>{item}</span>)}
              </div>
            </div>
            <div className="flex w-full flex-none flex-wrap items-center gap-x-2 gap-y-1 sm:w-auto sm:justify-end">
              <div className="flex flex-wrap items-center gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!copyableViewerContent(viewer)} onClick={() => void copyView('content')} title="Copy visible content" aria-label="Copy visible content">
                  {copied === 'content' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!viewPath || viewer.kind === 'loading' || downloading} onClick={() => void downloadView()} title="Download file" aria-label="Download file">
                  {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                </Button>
                <Button variant={wordWrap ? 'outline' : 'ghost'} size="icon" className="h-7 w-7" disabled={viewer.kind !== 'text'} onClick={() => setWordWrap((value) => !value)} title="Toggle word wrap" aria-label="Toggle word wrap">
                  <WrapText className="h-3.5 w-3.5" />
                </Button>
                {isMarkdownViewer(viewer) ? (
                  <Button variant={markdownMode === 'preview' ? 'outline' : 'ghost'} size="sm" className="h-7 px-2 text-[11px]" onClick={() => setMarkdownMode((value) => value === 'preview' ? 'source' : 'preview')} title={markdownMode === 'preview' ? 'Show Markdown source' : 'Preview Markdown'} aria-label={markdownMode === 'preview' ? 'Show Markdown source' : 'Preview Markdown'}>
                    {markdownMode === 'preview' ? 'Source' : 'Preview'}
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-1 sm:border-l sm:border-border sm:pl-2">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={viewer.kind !== 'text' || fontSizeDelta <= -2} onClick={() => setFontSizeDelta((value) => Math.max(-2, value - 1))} title="Decrease file view font size" aria-label="Decrease file view font size">
                  <Minus className="h-3.5 w-3.5" />
                </Button>
                <div className="flex h-7 min-w-9 items-center justify-center rounded border border-border px-1.5 font-mono text-[11px] text-muted-foreground" title={`Current modal font size: ${effectiveFontSize}px`} aria-label={`Current modal font size: ${effectiveFontSize}px`} data-testid="session-file-view-font-size">
                  {effectiveFontSize}px
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={viewer.kind !== 'text' || fontSizeDelta >= 2} onClick={() => setFontSizeDelta((value) => Math.min(2, value + 1))} title="Increase file view font size" aria-label="Increase file view font size">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="sm:border-l sm:border-border sm:pl-2">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!viewPath || viewer.kind === 'loading'} onClick={() => void viewFile()} title="Refresh file" aria-label="Refresh file">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
          <DialogDescription className="sr-only">Read-only file view.</DialogDescription>
        </DialogHeader>
        <div className="h-[min(68dvh,720px)] min-h-0 sm:h-[min(74dvh,720px)]">
          <FileView viewer={viewer} path={viewPath} target={viewTarget ?? undefined} chrome={false} wordWrap={wordWrap} fontSizeDelta={fontSizeDelta} markdownMode={markdownMode} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SessionFilesPanelImpl({
  socket,
  workspaceId,
  sessionId,
  cwd,
  mode = 'dialog',
  fontSizePx = 12,
}: {
  socket: DashboardSocket | null
  workspaceId?: string
  sessionId: string | null
  cwd?: string
  mode?: 'dialog' | 'sidebar'
  fontSizePx?: number
}): JSX.Element {
  const [nodes, setNodes] = useState<FileNode[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<FileNode | null>(null)
  const [viewer, setViewer] = useState<FileViewState>({ kind: 'empty' })
  const [viewOpen, setViewOpen] = useState(false)
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null)
  const online = Boolean(socket && workspaceId)
  const [treeHostRef, treeSize] = useElementSize<HTMLDivElement>()

  const loadDir = useCallback(async (path?: string): Promise<void> => {
    if (!socket || !workspaceId) return
    const targetPath = path ?? cwd
    setLoadingPath(targetPath ?? '__root__')
    const result = await requestDir(socket, workspaceId, sessionId ?? undefined, targetPath)
    setLoadingPath(null)
    if (result.error) {
      setViewer({ kind: 'error', message: result.error })
      return
    }
    const next = result.entries.map(entryToNode)
    if (!path) {
      setNodes(next)
      return
    }
    setNodes((prev) => updateNodeChildren(prev, path, next))
  }, [cwd, sessionId, socket, workspaceId])

  useEffect(() => {
    setNodes([])
    setSelected(null)
    setViewer({ kind: 'empty' })
    if (online) void loadDir()
  }, [online, loadDir, sessionId])

  const openNode = useCallback(async (node: FileNode): Promise<void> => {
    setSelected(node)
    if (node.type === 'directory') {
      if (!node.loaded) await loadDir(node.path)
      return
    }
    if (!socket || !workspaceId) return
    if (mode === 'sidebar') {
      setViewOpen(true)
      return
    }
    setViewer({ kind: 'loading', path: node.path })
    const result = await requestFile(socket, workspaceId, sessionId ?? undefined, node.path, { cwd })
    setViewer(fileResultToViewState(result))
  }, [cwd, loadDir, mode, sessionId, socket, workspaceId])

  const downloadNode = useCallback(async (node: FileNode): Promise<void> => {
    if (node.type !== 'file' || !socket || !workspaceId) return
    setDownloadingPath(node.path)
    try {
      const cachedViewer = viewerPath(viewer) === node.path ? viewer : undefined
      await downloadWorkspaceFile(socket, workspaceId, sessionId ?? undefined, node.path, cachedViewer, cwd)
    } finally {
      setDownloadingPath((current) => current === node.path ? null : current)
    }
  }, [cwd, sessionId, socket, viewer, workspaceId])

  if (mode === 'sidebar') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground" data-testid="session-files-panel">
        <div ref={treeHostRef} className="min-h-0 flex-1 overflow-hidden p-1">
          {!online ? (
            <div className="p-3 text-xs text-sidebar-foreground/60">Workspace executor is offline.</div>
          ) : nodes.length === 0 && loadingPath ? (
            <div className="flex items-center gap-2 p-3 text-xs text-sidebar-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading files</div>
          ) : nodes.length === 0 ? (
            <div className="p-3 text-xs text-sidebar-foreground/60">No files.</div>
          ) : (
            <Tree<FileNode> data={nodes} width="100%" height={Math.max(120, treeSize.height)} indent={14} rowHeight={28} openByDefault={false} onActivate={(node) => void openNode(node.data)}>
              {(props) => <FileTreeRow {...props} fontSizePx={fontSizePx} onDownload={downloadNode} downloadingPath={downloadingPath} surface="sidebar" />}
            </Tree>
          )}
        </div>
        <WorkspaceFileViewDialog
          open={viewOpen}
          onOpenChange={setViewOpen}
          socket={socket}
          workspaceId={workspaceId}
          sessionId={sessionId ?? undefined}
          cwd={cwd}
          path={selected?.type === 'file' ? selected.path : undefined}
        />
      </div>
    )
  }

  return (
    <div className="grid h-[min(82dvh,760px)] min-h-0 grid-cols-1 grid-rows-[minmax(160px,0.75fr)_minmax(220px,1fr)_180px] overflow-hidden rounded-md border border-border bg-background md:h-[min(78vh,760px)] md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)_220px]" data-testid="session-files-panel">
      <div className="flex min-h-0 flex-col border-b border-border bg-muted/20 md:border-b-0 md:border-r">
        <div className="flex h-10 items-center justify-between border-b border-border px-2">
          <div className="min-w-0 truncate text-xs font-medium">Files</div>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!online || loadingPath !== null} onClick={() => void loadDir()} title="Refresh files" aria-label="Refresh files">
            {loadingPath ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <div ref={treeHostRef} className="min-h-0 flex-1 overflow-hidden p-1">
          {!online ? (
            <div className="p-3 text-xs text-muted-foreground">Workspace executor is offline.</div>
          ) : nodes.length === 0 && loadingPath ? (
            <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading files</div>
          ) : (
            <Tree<FileNode> data={nodes} width="100%" height={Math.max(120, treeSize.height)} indent={16} rowHeight={30} openByDefault={false} onActivate={(node) => void openNode(node.data)}>
              {(props) => <FileTreeRow {...props} fontSizePx={fontSizePx} onDownload={downloadNode} downloadingPath={downloadingPath} />}
            </Tree>
          )}
        </div>
      </div>
      <FileView viewer={viewer} selected={selected} />
      <div className="min-h-0 border-t border-border md:col-span-2">
        {sessionId !== null ? (
          <SessionTerminal key={`${workspaceId ?? 'offline'}:${sessionId}`} socket={socket} workspaceId={workspaceId} sessionId={sessionId} cwd={cwd} />
        ) : null}
      </div>
    </div>
  )
}

export const SessionFilesPanel = memo(SessionFilesPanelImpl)

function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, { width: number; height: number }] {
  const [node, setNode] = useState<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!node) return
    const update = (): void => setSize({ width: node.clientWidth, height: node.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return [setNode, size]
}

function FileTreeRow({
  node,
  style,
  fontSizePx,
  onDownload,
  downloadingPath,
  surface = 'default',
}: {
  node: NodeApi<FileNode>
  style: CSSProperties
  fontSizePx: number
  onDownload?: (node: FileNode) => void | Promise<void>
  downloadingPath?: string | null
  surface?: 'default' | 'sidebar'
}): JSX.Element {
  const item = node.data
  const downloading = downloadingPath === item.path
  const sidebar = surface === 'sidebar'
  return (
    <div className="flex w-full min-w-0 items-center" style={{ ...style, fontSize: fontSizePx }}>
      <button
        type="button"
        className={cn(
          'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left',
          sidebar ? 'hover:bg-sidebar-accent' : 'hover:bg-accent',
          node.isSelected && (sidebar ? 'bg-sidebar-accent text-sidebar-foreground' : 'bg-accent text-accent-foreground'),
        )}
        onClick={() => {
          node.activate()
          if (item.type === 'directory') node.toggle()
        }}
        data-testid={`session-file-${item.type}`}
      >
        {item.type === 'directory'
          ? node.isOpen
            ? <ChevronDown className={cn('h-3 w-3 flex-none', sidebar ? 'text-sidebar-foreground/55' : 'text-muted-foreground')} />
            : <ChevronRight className={cn('h-3 w-3 flex-none', sidebar ? 'text-sidebar-foreground/55' : 'text-muted-foreground')} />
          : <span className="h-3 w-3 flex-none" />}
        {item.type === 'directory' ? <Folder className="h-3.5 w-3.5 flex-none text-sky-500" /> : <File className={cn('h-3.5 w-3.5 flex-none', sidebar ? 'text-sidebar-foreground/55' : 'text-muted-foreground')} />}
        <span className="min-w-0 truncate">{item.name}</span>
        {item.type === 'file' && item.size !== undefined ? <span className={cn('ml-auto hidden flex-none text-[10px] sm:inline', sidebar ? 'text-sidebar-foreground/45' : 'text-muted-foreground')}>{formatBytes(item.size)}</span> : null}
      </button>
      {item.type === 'file' ? (
        <button
          type="button"
          className={cn('ml-1 flex h-6 w-6 flex-none items-center justify-center rounded', sidebar ? 'text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
          title="Download file"
          aria-label={`Download ${item.name}`}
          onClick={(event) => {
            event.stopPropagation()
            void onDownload?.(item)
          }}
        >
          {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        </button>
      ) : null}
    </div>
  )
}

type FileViewState =
  | { kind: 'empty' }
  | { kind: 'loading'; path: string }
  | { kind: 'text'; path: string; content: string; size?: number; truncated?: boolean; error?: string }
  | { kind: 'image'; path: string; content: string; size?: number; mediaType: string }
  | { kind: 'pdf'; path: string; content: string; size?: number; mediaType: string }
  | { kind: 'binary'; path?: string; size?: number; message?: string; content?: string; mediaType?: string }
  | { kind: 'too_large' | 'not_found' | 'error'; path?: string; size?: number; message?: string }

function FileView({ viewer, selected, path, target, chrome = true, wordWrap = true, fontSizeDelta = 0, markdownMode = 'source' }: { viewer: FileViewState; selected?: FileNode | null; path?: string; target?: WorkspaceFileTarget; chrome?: boolean; wordWrap?: boolean; fontSizeDelta?: number; markdownMode?: 'preview' | 'source' }): JSX.Element {
  const activePath = selected?.path ?? path ?? viewerPath(viewer)
  const language = useMemo(() => activePath ? languageForPath(activePath) : 'plaintext', [activePath])
  const fontSize = useFileViewFontSize(fontSizeDelta)
  if (viewer.kind === 'empty') return <ViewerShell title="File view" chrome={chrome}><EmptyViewer /></ViewerShell>
  if (viewer.kind === 'loading') return <ViewerShell title={viewer.path} chrome={chrome}><div className="flex items-center gap-2 p-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading file</div></ViewerShell>
  if (viewer.kind === 'image') {
    return (
      <ViewerShell title={viewer.path} meta={viewerMeta(viewer).join(' · ')} chrome={chrome}>
        <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/25 p-4">
          <img className="max-h-full max-w-full object-contain" src={`data:${viewer.mediaType};base64,${viewer.content}`} alt={viewer.path} />
        </div>
      </ViewerShell>
    )
  }
  if (viewer.kind === 'pdf') {
    return (
      <ViewerShell title={viewer.path} meta={viewerMeta(viewer).join(' · ')} chrome={chrome}>
        <object className="h-full w-full bg-muted/25" data={`data:${viewer.mediaType};base64,${viewer.content}`} type={viewer.mediaType} data-testid="session-file-pdf-viewer">
          <div className="p-4 text-sm text-muted-foreground">PDF view is unavailable in this browser.</div>
        </object>
      </ViewerShell>
    )
  }
  if (viewer.kind !== 'text') {
    return <ViewerShell title={viewer.path ?? 'File view'} chrome={chrome}><FallbackViewer kind={viewer.kind} size={viewer.size} message={viewer.message} /></ViewerShell>
  }
  return (
    <ViewerShell title={viewer.path} meta={`${viewer.size !== undefined ? formatBytes(viewer.size) : ''}${viewer.truncated ? ' · view truncated' : ''}`} chrome={chrome}>
      {viewer.truncated ? <div className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Large file view is capped. Full content was not loaded.</div> : null}
      {language === 'markdown' && markdownMode === 'preview' ? (
        <MarkdownFileView content={viewer.content} />
      ) : (
        <Editor
          value={viewer.content}
          language={language}
          theme="vs-dark"
          onMount={(editor) => {
            if (!target?.line) return
            const column = target.column ?? 1
            editor.setPosition({ lineNumber: target.line, column })
            editor.revealLineInCenter(target.line)
          }}
          options={{ readOnly: true, minimap: { enabled: false }, wordWrap: wordWrap ? 'on' : 'off', fontSize, scrollBeyondLastLine: false, automaticLayout: true }}
        />
      )}
    </ViewerShell>
  )
}

function MarkdownFileView({ content }: { content: string }): JSX.Element {
  return (
    <div className="h-full min-h-0 overflow-auto bg-background px-4 py-4 text-sm leading-6 sm:px-6 sm:py-5" data-testid="session-file-markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        h1: ({ children }) => <h1 className="mb-3 mt-0 text-xl font-semibold leading-tight sm:text-2xl">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-5 text-lg font-semibold leading-tight sm:text-xl">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold leading-tight">{children}</h3>,
        p: ({ children }) => <p className="my-2 text-foreground/90">{children}</p>,
        ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
        li: ({ children }) => <li className="my-1">{children}</li>,
        a: ({ children, href }) => <a className="text-primary underline underline-offset-2" href={href} target="_blank" rel="noreferrer">{children}</a>,
        code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{children}</code>,
        pre: ({ children }) => <pre className="my-3 overflow-auto rounded bg-muted p-3 font-mono text-xs leading-5">{children}</pre>,
        blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
        table: ({ children }) => <div className="my-3 overflow-auto"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
        th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
      }}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

function useFileViewFontSize(delta = 0): number {
  const [fontSizePref] = useNumberPref(PREF_FILE_VIEW_FONT_SIZE, DEFAULT_FILE_VIEW_FONT_SIZE, { min: 0, max: FILE_VIEW_FONT_SIZE_PX.length - 1 })
  const fontSizeIndex = Math.min(FILE_VIEW_FONT_SIZE_PX.length - 1, Math.max(0, fontSizePref + delta))
  return FILE_VIEW_FONT_SIZE_PX[fontSizeIndex] ?? FILE_VIEW_FONT_SIZE_PX[DEFAULT_FILE_VIEW_FONT_SIZE]
}

function ViewerShell({ title, meta, children, chrome = true }: { title: string; meta?: string; children: ReactNode; chrome?: boolean }): JSX.Element {
  if (!chrome) return <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">{children}</div>
  return <div className="flex h-full min-h-0 min-w-0 flex-col"><div className="flex h-10 items-center gap-2 border-b border-border px-3"><div className="min-w-0 truncate font-mono text-xs">{title}</div>{meta ? <div className="ml-auto flex-none text-xs text-muted-foreground">{meta}</div> : null}</div><div className="min-h-0 flex-1 overflow-hidden">{children}</div></div>
}

function viewerTitle(viewer: FileViewState, path?: string | null): string {
  if (viewer.kind === 'empty') return path ?? 'File view'
  if (viewer.kind === 'loading') return viewer.path
  return viewer.path ?? path ?? 'File view'
}

function viewerMeta(viewer: FileViewState): string[] {
  const items: string[] = []
  if ('size' in viewer && viewer.size !== undefined) items.push(formatBytes(viewer.size))
  if (viewer.kind === 'text') items.push(viewer.truncated ? 'view truncated' : 'text')
  if (viewer.kind === 'image') items.push(viewer.mediaType)
  if (viewer.kind === 'pdf') items.push(viewer.mediaType)
  if (viewer.kind === 'too_large') items.push('too large')
  if (viewer.kind === 'binary') items.push('binary')
  if (viewer.kind === 'not_found') items.push('not found')
  return items
}

function viewerPath(viewer: FileViewState): string | undefined {
  return 'path' in viewer ? viewer.path : undefined
}

function copyableViewerContent(viewer: FileViewState): string | undefined {
  if (viewer.kind === 'text') return viewer.content
  if (viewer.kind === 'image') return `data:${viewer.mediaType};base64,${viewer.content}`
  if (viewer.kind === 'pdf') return `data:${viewer.mediaType};base64,${viewer.content}`
  return undefined
}

async function downloadWorkspaceFile(socket: DashboardSocket, workspaceId: string, sessionId: string | undefined, path: string, cachedViewer?: FileViewState, cwd?: string): Promise<void> {
  const cached = cachedViewer && viewerPath(cachedViewer) === path ? downloadableBlob(cachedViewer) : undefined
  if (cached) {
    saveBlob(cached.blob, downloadFilename(path))
    notify.success('Download started', { description: path, id: `file-download:${path}` })
    return
  }
  const result = await requestFile(socket, workspaceId, sessionId, path, { cwd, download: true, maxBytes: FILE_DOWNLOAD_MAX_BYTES, timeoutMs: 120_000 })
  const viewer = fileResultToViewState(result)
  const downloadable = downloadableBlob(viewer)
  if (!downloadable || result.truncated || result.kind === 'too_large') {
    notify.error('File download unavailable', { description: result.error ?? 'The file is too large or cannot be read by the executor.', id: `file-download:${path}` })
    return
  }
  saveBlob(downloadable.blob, downloadFilename(path))
  notify.success('Download started', { description: path, id: `file-download:${path}` })
}

function downloadableBlob(viewer: FileViewState): { blob: Blob } | undefined {
  if (viewer.kind === 'text' || viewer.kind === 'image' || viewer.kind === 'pdf' || viewer.kind === 'binary') return fileResultDownloadBlob(viewer)
  return undefined
}

function isMarkdownViewer(viewer: FileViewState): boolean {
  return viewer.kind === 'text' && languageForPath(viewer.path) === 'markdown'
}

function EmptyViewer(): JSX.Element {
  return <div className="p-4 text-xs text-muted-foreground">Select a file to view it.</div>
}

function FallbackViewer({ kind, size, message }: { kind: string; size?: number; message?: string }): JSX.Element {
  const diagnostic = fileViewDiagnostic(kind, message)
  return (
    <div className="space-y-2 p-4 text-sm">
      <div className="font-medium">{diagnostic.title}</div>
      <div className="text-xs text-muted-foreground">{diagnostic.description}{size !== undefined ? ` · ${formatBytes(size)}` : ''}</div>
      {message && message !== diagnostic.description ? <div className="max-w-full break-words rounded bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">{message}</div> : null}
    </div>
  )
}

function fileViewDiagnostic(kind: string, message?: string): { title: string; description: string } {
  const lower = (message ?? '').toLowerCase()
  if (kind === 'not_found' || lower.includes('enoent')) return { title: 'File not found', description: 'The file may have been deleted, moved, or generated in a different workspace.' }
  if (kind === 'binary') return { title: 'Binary file cannot be viewed', description: 'This file is binary. Use another tool to inspect or download it.' }
  if (kind === 'too_large') return { title: 'File is too large to view fully', description: 'The file exceeds the file view size limit.' }
  if (lower.includes('outside') || lower.includes('sandbox') || lower.includes('eacces') || lower.includes('permission')) return { title: 'File is outside the allowed workspace', description: 'The executor sandbox or file permissions blocked this path.' }
  if (lower.includes('offline') || lower.includes('no executor')) return { title: 'Workspace executor is offline', description: 'Start or reconnect the workspace executor, then try again.' }
  if (lower.includes('timed out') || lower.includes('timeout')) return { title: 'File view timed out', description: 'The executor did not return file contents in time.' }
  return { title: 'View unavailable', description: message ?? kind }
}

function fileResultToViewState(result: FileContentsResult): FileViewState {
  if (result.kind === 'binary' && result.content !== undefined) {
    return { kind: 'binary', path: result.path, content: result.content, size: result.size, mediaType: result.mediaType, message: result.error }
  }
  if (result.kind === 'image' && result.content !== undefined) {
    return { kind: 'image', path: result.path, content: result.content, size: result.size, mediaType: result.mediaType ?? 'application/octet-stream' }
  }
  if ((result.kind === 'pdf' || result.mediaType === 'application/pdf') && result.content !== undefined) {
    return { kind: 'pdf', path: result.path, content: result.content, size: result.size, mediaType: result.mediaType ?? 'application/pdf' }
  }
  if (result.content !== undefined) {
    return { kind: 'text', path: result.path, content: result.content, size: result.size, truncated: result.truncated, error: result.error }
  }
  const kind = result.kind === 'binary' || result.kind === 'too_large' || result.kind === 'not_found' ? result.kind : 'error'
  return { kind, path: result.path, size: result.size, message: result.error ?? 'file cannot be viewed' }
}

function SessionTerminal({ socket, workspaceId, sessionId, cwd }: { socket: DashboardSocket | null; workspaceId?: string; sessionId: string; cwd?: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'starting' | 'running' | 'exited' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const term = new XTerm({ cursorBlink: true, fontSize: 12, convertEol: true, rows: 8, theme: { background: '#0b0f14' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new SearchAddon())
    terminalRef.current = term
    fitRef.current = fit
    if (hostRef.current) {
      term.open(hostRef.current)
      fit.fit()
    }
    return () => {
      term.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const fitAndResize = (): void => {
      fitRef.current?.fit()
      const term = terminalRef.current
      if (!term || !socket || !workspaceId || !terminalId || status !== 'running') return
      socket.emit('terminal:resize', { workspaceId, sessionId, terminalId, cols: term.cols, rows: term.rows })
    }
    const observer = new ResizeObserver(fitAndResize)
    observer.observe(host)
    fitAndResize()
    return () => observer.disconnect()
  }, [socket, workspaceId, sessionId, terminalId, status])

  useEffect(() => {
    return () => {
      if (!socket || !workspaceId || !terminalId) return
      socket.emit('terminal:kill', { requestId: crypto.randomUUID(), workspaceId, sessionId, terminalId }, () => {})
    }
  }, [socket, workspaceId, sessionId, terminalId])

  useEffect(() => {
    if (!socket) return
    const onOutput = (payload: ServerTerminalOutput): void => {
      if (payload.sessionId !== sessionId || payload.terminalId !== terminalId) return
      terminalRef.current?.write(payload.data)
    }
    const onExit = (payload: ServerTerminalExit): void => {
      if (payload.sessionId !== sessionId || payload.terminalId !== terminalId) return
      setStatus('exited')
      terminalRef.current?.writeln(`\r\n[process exited: ${payload.exitCode ?? payload.signal ?? 'unknown'}]`)
    }
    socket.on('server:terminal_output', onOutput)
    socket.on('server:terminal_exit', onExit)
    return () => {
      socket.off('server:terminal_output', onOutput)
      socket.off('server:terminal_exit', onExit)
    }
  }, [socket, sessionId, terminalId])

  useEffect(() => {
    const term = terminalRef.current
    if (!term || !socket || !workspaceId || !terminalId) return
    const dispose = term.onData((data) => {
      socket.emit('terminal:input', { workspaceId, sessionId, terminalId, data })
    })
    return () => dispose.dispose()
  }, [socket, workspaceId, sessionId, terminalId])

  const start = async (): Promise<void> => {
    if (!socket || !workspaceId) return
    setStatus('starting')
    setError(null)
    fitRef.current?.fit()
    const term = terminalRef.current
    const result = await createTerminal(socket, { workspaceId, sessionId, cwd, cols: term?.cols ?? 100, rows: term?.rows ?? 8 })
    if (result.error || !result.terminalId) {
      setStatus('error')
      setError(result.error ?? 'failed to create terminal')
      return
    }
    setTerminalId(result.terminalId)
    setStatus('running')
    terminalRef.current?.writeln(`connected: ${result.cwd ?? ''}`)
    fitRef.current?.fit()
  }

  const kill = async (): Promise<void> => {
    if (!socket || !workspaceId || !terminalId) return
    const result = await killTerminal(socket, { workspaceId, sessionId, terminalId })
    if (!result.killed && result.error) setError(result.error)
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-black text-white md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-1">
      <div className="border-b border-white/10 bg-background p-2 text-foreground md:border-b-0 md:border-r md:p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium md:mb-3"><SquareTerminal className="h-4 w-4" /> Terminal</div>
        <div className="flex gap-2 md:block md:space-y-2">
          <Button className="h-8 flex-1 justify-center gap-2 md:w-full md:justify-start" size="sm" disabled={!socket || !workspaceId || status === 'starting' || status === 'running'} onClick={() => void start()}><Play className="h-3.5 w-3.5" /> Start</Button>
          <Button className="h-8 flex-1 justify-center gap-2 md:w-full md:justify-start" size="sm" variant="outline" disabled={!terminalId || status !== 'running'} onClick={() => void kill()}><X className="h-3.5 w-3.5" /> Kill</Button>
        </div>
        <div className="mt-2 truncate text-xs text-muted-foreground md:mt-3">{status}{error ? ` · ${error}` : ''}</div>
      </div>
      <div ref={hostRef} className="min-h-0 min-w-0 overflow-hidden p-1" />
    </div>
  )
}

async function requestDir(socket: DashboardSocket, workspaceId: string, sessionId: string | undefined, path: string | undefined): Promise<DirListResult> {
  return await new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    const timer = window.setTimeout(() => {
      socket.off('server:dir_list', handler)
      resolve({ requestId, workspaceId, path: path ?? '', roots: [], entries: [], error: 'timed out' })
    }, 5000)
    const handler = (result: DirListResult): void => {
      if (result.requestId !== requestId) return
      window.clearTimeout(timer)
      socket.off('server:dir_list', handler)
      resolve(result)
    }
    socket.on('server:dir_list', handler)
    socket.emit('client:list_dirs', { requestId, workspaceId, ...(sessionId ? { sessionId } : {}), ...(path ? { path } : {}) })
  })
}

async function requestFile(socket: DashboardSocket, workspaceId: string, sessionId: string | undefined, path: string, options: { cwd?: string; maxBytes?: number; download?: boolean; timeoutMs?: number } = {}): Promise<FileContentsResult> {
  // Uses the generic workspace:read_binary channel introduced by the
  // workspace-exec refactor (docs/planning/roadmap-notes/workspace-exec-
  // refactor.md). We keep returning FileContentsResult so the surrounding
  // viewer / download logic stays unchanged; MIME → kind mapping happens
  // in classifyFileContent() below.
  const requestId = crypto.randomUUID()
  void sessionId
  const res = await workspaceReadBinary(socket, workspaceId, path, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    maxBytes: options.maxBytes ?? FILE_PREVIEW_MAX_BYTES,
    ackTimeoutMs: options.timeoutMs ?? 8000,
  })
  return classifyReadBinaryResult(requestId, workspaceId, path, res)
}

function classifyReadBinaryResult(
  requestId: string,
  workspaceId: string,
  path: string,
  res: Awaited<ReturnType<typeof workspaceReadBinary>>,
): FileContentsResult {
  if (res.error) {
    const code = res.error.code
    const kind: FileContentsResult['kind'] =
      code === 'ENOENT' ? 'not_found'
      : code === 'EACCES' ? 'error'
      : code === 'EINVAL' ? 'error'
      : 'error'
    return { requestId, workspaceId, path, kind, error: res.error.message }
  }
  const mime = res.mime
  const isImage = mime.startsWith('image/')
  const isPdf = mime === 'application/pdf'
  const isText = mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml'
  const truncated = res.truncated !== undefined
  if (isImage) {
    return { requestId, workspaceId, path, kind: 'image', content: res.base64, encoding: 'base64', mediaType: mime, size: res.size, ...(truncated ? { truncated: true } : {}) }
  }
  if (isPdf) {
    return { requestId, workspaceId, path, kind: 'pdf', content: res.base64, encoding: 'base64', mediaType: mime, size: res.size, ...(truncated ? { truncated: true } : {}) }
  }
  if (isText) {
    // For text-shaped MIME, decode UTF-8 for the viewer. Callers who need
    // the raw base64 (downloads) also receive `content` at the base64 path
    // via encoding='base64' — for text, we hand back UTF-8.
    const bytes = base64ToBytes(res.base64)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    return { requestId, workspaceId, path, kind: 'text', content: text, encoding: 'utf8', mediaType: mime, size: res.size, ...(truncated ? { truncated: true } : {}) }
  }
  return { requestId, workspaceId, path, kind: 'binary', content: res.base64, encoding: 'base64', mediaType: mime, size: res.size, ...(truncated ? { truncated: true } : {}) }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function createTerminal(socket: DashboardSocket, payload: { workspaceId: string; sessionId: string; cwd?: string; cols: number; rows: number }): Promise<TerminalCreateResult> {
  return await new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    const timer = window.setTimeout(() => resolve({ requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error: 'timed out' }), 5000)
    socket.emit('terminal:create', { requestId, ...payload }, (result) => {
      window.clearTimeout(timer)
      resolve(result)
    })
  })
}

async function killTerminal(socket: DashboardSocket, payload: { workspaceId: string; sessionId: string; terminalId: string }): Promise<TerminalKillResult> {
  return await new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    const timer = window.setTimeout(() => resolve({ requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'timed out' }), 5000)
    socket.emit('terminal:kill', { requestId, ...payload }, (result) => {
      window.clearTimeout(timer)
      resolve(result)
    })
  })
}

function entryToNode(entry: DirListEntry): FileNode {
  const type = entry.type ?? 'directory'
  return { id: entry.path, name: entry.name, path: entry.path, type, ...(entry.size !== undefined ? { size: entry.size } : {}), ...(type === 'directory' ? { children: [], loaded: false } : {}) }
}

function updateNodeChildren(nodes: readonly FileNode[], path: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === path) return { ...node, children, loaded: true }
    if (node.children) return { ...node, children: updateNodeChildren(node.children, path, children) }
    return node
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'ts' || ext === 'tsx') return 'typescript'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  if (ext === 'json') return 'json'
  if (ext === 'css') return 'css'
  if (ext === 'html') return 'html'
  if (ext === 'md') return 'markdown'
  if (ext === 'py') return 'python'
  if (ext === 'rs') return 'rust'
  if (ext === 'go') return 'go'
  if (ext === 'java') return 'java'
  if (ext === 'sh' || ext === 'bash') return 'shell'
  return 'plaintext'
}
