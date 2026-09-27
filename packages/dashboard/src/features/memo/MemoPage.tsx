import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  AlertCircle,
  Bold,
  Check,
  Code2,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Pilcrow,
  Quote,
  Redo2,
  Save,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import { ProductPage, ProductPageBody, ProductPageHeader, ProductPanel } from '../../components/ui/product-page.js'
import { sanitizeMemoHtml } from './memo-html.js'
import './memo-editor.css'

type MemoDocument = { content: string; revision: number; updatedAt: string }
type SaveStatus = 'loading' | 'saved' | 'saving' | 'error' | 'conflict'
type ImageNotice = 'size' | 'type' | 'read' | null

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'))
    reader.readAsDataURL(file)
  })
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick(): void
  children: React.ReactNode
}): JSX.Element {
  const preserveSelection = (event: ReactMouseEvent<HTMLButtonElement>): void => event.preventDefault()
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={active ? 'memo-toolbar__button memo-toolbar__button--active' : 'memo-toolbar__button'}
      aria-label={label}
      aria-pressed={active || undefined}
      title={label}
      disabled={disabled}
      onMouseDown={preserveSelection}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

type ToolbarLabels = {
  toolbar: string
  undo: string
  redo: string
  paragraph: string
  heading1: string
  heading2: string
  bold: string
  italic: string
  underline: string
  strike: string
  bulletList: string
  orderedList: string
  quote: string
  codeBlock: string
  link: string
  image: string
}

function MemoToolbar({ editor, onImage, onLink, labels }: {
  editor: Editor | null
  onImage(): void
  onLink(): void
  labels: ToolbarLabels
}): JSX.Element {
  const unavailable = !editor || !editor.isEditable
  return (
    <div className="memo-toolbar" role="toolbar" aria-label={labels.toolbar} aria-controls="memo-editor">
      <div className="memo-toolbar__group">
        <ToolbarButton label={labels.undo} disabled={unavailable || !editor?.can().chain().focus().undo().run()} onClick={() => editor?.chain().focus().undo().run()}><Undo2 /></ToolbarButton>
        <ToolbarButton label={labels.redo} disabled={unavailable || !editor?.can().chain().focus().redo().run()} onClick={() => editor?.chain().focus().redo().run()}><Redo2 /></ToolbarButton>
      </div>
      <span className="memo-toolbar__separator" aria-hidden="true" />
      <div className="memo-toolbar__group">
        <ToolbarButton label={labels.paragraph} active={editor?.isActive('paragraph')} disabled={unavailable} onClick={() => editor?.chain().focus().setParagraph().run()}><Pilcrow /></ToolbarButton>
        <ToolbarButton label={labels.heading1} active={editor?.isActive('heading', { level: 1 })} disabled={unavailable} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 /></ToolbarButton>
        <ToolbarButton label={labels.heading2} active={editor?.isActive('heading', { level: 2 })} disabled={unavailable} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></ToolbarButton>
      </div>
      <span className="memo-toolbar__separator" aria-hidden="true" />
      <div className="memo-toolbar__group">
        <ToolbarButton label={labels.bold} active={editor?.isActive('bold')} disabled={unavailable} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold /></ToolbarButton>
        <ToolbarButton label={labels.italic} active={editor?.isActive('italic')} disabled={unavailable} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic /></ToolbarButton>
        <ToolbarButton label={labels.underline} active={editor?.isActive('underline')} disabled={unavailable} onClick={() => editor?.chain().focus().toggleUnderline().run()}><UnderlineIcon /></ToolbarButton>
        <ToolbarButton label={labels.strike} active={editor?.isActive('strike')} disabled={unavailable} onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough /></ToolbarButton>
      </div>
      <span className="memo-toolbar__separator" aria-hidden="true" />
      <div className="memo-toolbar__group">
        <ToolbarButton label={labels.bulletList} active={editor?.isActive('bulletList')} disabled={unavailable} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List /></ToolbarButton>
        <ToolbarButton label={labels.orderedList} active={editor?.isActive('orderedList')} disabled={unavailable} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered /></ToolbarButton>
        <ToolbarButton label={labels.quote} active={editor?.isActive('blockquote')} disabled={unavailable} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote /></ToolbarButton>
        <ToolbarButton label={labels.codeBlock} active={editor?.isActive('codeBlock')} disabled={unavailable} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}><Code2 /></ToolbarButton>
      </div>
      <span className="memo-toolbar__separator" aria-hidden="true" />
      <div className="memo-toolbar__group">
        <ToolbarButton label={labels.link} active={editor?.isActive('link')} disabled={unavailable} onClick={onLink}><Link2 /></ToolbarButton>
        <ToolbarButton label={labels.image} disabled={unavailable} onClick={onImage}><ImagePlus /></ToolbarButton>
      </div>
    </div>
  )
}

export function MemoPage(): JSX.Element {
  const { t } = useTranslation()
  const [memoDocument, setMemoDocument] = useState<MemoDocument | null>(null)
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<SaveStatus>('loading')
  const [imageNotice, setImageNotice] = useState<ImageNotice>(null)
  const [selectionVersion, setSelectionVersion] = useState(0)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const dirty = useRef(false)
  const contentRef = useRef('')
  const persistedContentRef = useRef('')
  const saveInFlight = useRef(false)
  const insertImagesRef = useRef<(files: readonly File[], position?: number) => Promise<void>>()

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https' }),
      Image.configure({ allowBase64: true }),
      Placeholder.configure({ placeholder: t('memo.placeholder') }),
    ],
    content: '',
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        id: 'memo-editor',
        class: 'memo-editor__content',
        role: 'textbox',
        'aria-label': t('memo.editor'),
        'aria-multiline': 'true',
        'aria-keyshortcuts': 'Control+S Meta+S Control+K Meta+K',
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (!files.some((file) => file.type.startsWith('image/'))) return false
        event.preventDefault()
        void insertImagesRef.current?.(files)
        return true
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (!files.some((file) => file.type.startsWith('image/'))) return false
        event.preventDefault()
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void insertImagesRef.current?.(files, position)
        return true
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      const next = currentEditor.getHTML()
      contentRef.current = next
      dirty.current = next !== persistedContentRef.current
      setContent(next)
    },
    onSelectionUpdate: () => setSelectionVersion((value) => value + 1),
  }, [t])

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading')
    try {
      const response = await fetch('/memo', { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) { setStatus('error'); return }
      const next = await response.json() as MemoDocument
      const safe = sanitizeMemoHtml(next.content)
      editor?.commands.setContent(safe, { emitUpdate: false })
      const normalized = editor?.getHTML() ?? safe
      contentRef.current = normalized
      persistedContentRef.current = normalized
      setMemoDocument(next)
      setContent(normalized)
      dirty.current = false
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }, [editor])

  const save = useCallback(async (expectedRevision: number): Promise<void> => {
    if (saveInFlight.current) return
    saveInFlight.current = true
    setStatus('saving')
    const savingSource = contentRef.current
    const savingContent = sanitizeMemoHtml(savingSource)
    try {
      const response = await fetch('/memo', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: savingContent, expectedRevision }),
      })
      if (response.status === 409) { setStatus('conflict'); return }
      if (!response.ok) { setStatus('error'); return }
      const next = await response.json() as MemoDocument
      const unchanged = contentRef.current === savingSource
      if (unchanged) persistedContentRef.current = savingSource
      dirty.current = !unchanged
      setMemoDocument(next)
      setStatus(unchanged ? 'saved' : 'saving')
      if (!unchanged) setContent(contentRef.current)
    } catch {
      setStatus('error')
    } finally {
      saveInFlight.current = false
    }
  }, [])

  const insertImages = useCallback(async (files: readonly File[], position?: number): Promise<void> => {
    if (!editor) return
    if (typeof position === 'number') editor.commands.setTextSelection(position)
    let inserted = false
    for (const file of files) {
      if (!SUPPORTED_IMAGE_TYPES.has(file.type)) { setImageNotice('type'); continue }
      if (file.size > MAX_IMAGE_BYTES) { setImageNotice('size'); continue }
      try {
        const src = await fileAsDataUrl(file)
        editor.chain().focus().setImage({ src, alt: file.name, title: file.name }).run()
        inserted = true
      } catch {
        setImageNotice('read')
      }
    }
    if (inserted) setImageNotice(null)
    if (fileInput.current) fileInput.current.value = ''
  }, [editor])
  insertImagesRef.current = insertImages

  const editLink = useCallback((): void => {
    if (!editor) return
    if (editor.isActive('link')) { editor.chain().focus().unsetLink().run(); return }
    const previous = editor.getAttributes('link').href as string | undefined
    const href = window.prompt(t('memo.linkPrompt'), previous ?? 'https://')?.trim()
    if (!href) return
    try {
      const url = new URL(href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.toString() }).run()
    } catch {
      // Invalid URLs are ignored rather than adding unsafe markup.
    }
  }, [editor, t])

  useEffect(() => { if (editor) void load() }, [editor, load])
  useEffect(() => { editor?.setEditable(status !== 'loading' && status !== 'conflict') }, [editor, status])
  useEffect(() => {
    if (!memoDocument || !dirty.current || status === 'conflict' || status === 'error') return
    const timer = window.setTimeout(() => { void save(memoDocument.revision) }, 500)
    return () => window.clearTimeout(timer)
  }, [content, memoDocument, save, status])
  useEffect(() => {
    const editorShortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !editor?.view.dom.contains(document.activeElement)) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        if (memoDocument && dirty.current) void save(memoDocument.revision)
      } else if (key === 'k') {
        event.preventDefault()
        editLink()
      }
    }
    window.addEventListener('keydown', editorShortcut)
    return () => window.removeEventListener('keydown', editorShortcut)
  }, [editLink, editor, memoDocument, save])

  const plainText = editor?.getText().trim() ?? ''
  const wordCount = plainText ? plainText.split(/\s+/u).length : 0
  const labels = {
    toolbar: t('memo.toolbar'), undo: t('memo.format.undo'), redo: t('memo.format.redo'), paragraph: t('memo.format.paragraph'),
    heading1: t('memo.format.heading1'), heading2: t('memo.format.heading2'), bold: t('memo.format.bold'), italic: t('memo.format.italic'),
    underline: t('memo.format.underline'), strike: t('memo.format.strike'), bulletList: t('memo.format.bulletList'), orderedList: t('memo.format.orderedList'),
    quote: t('memo.format.quote'), codeBlock: t('memo.format.codeBlock'), link: t('memo.format.link'), image: t('memo.image'),
  }
  void selectionVersion

  return (
    <ProductPage testId="memo-page" className="overflow-hidden">
      <ProductPageHeader
        eyebrow={null}
        title={t('memo.title')}
        description={t('memo.subtitle')}
        actions={(
          <div className={`memo-save-status memo-save-status--${status}`} role="status" aria-live="polite">
            {status === 'saving' || status === 'loading' ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {status === 'saved' ? <Check aria-hidden="true" /> : null}
            {status === 'error' || status === 'conflict' ? <AlertCircle aria-hidden="true" /> : null}
            <span>{t(`memo.status.${status}`)}</span>
            {status === 'conflict' ? <Button size="sm" variant="outline" onClick={() => void load()}>{t('memo.reload')}</Button> : null}
            {status === 'error' ? <Button size="sm" variant="outline" onClick={() => memoDocument && dirty.current ? void save(memoDocument.revision) : void load()}>{t('common.retry')}</Button> : null}
          </div>
        )}
      />
      <ProductPageBody className="flex min-h-0 flex-col">
        <ProductPanel className="memo-editor-shell">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => void insertImages(Array.from(event.target.files ?? []))}
          />
          <div className="memo-editor-shell__topbar">
            <MemoToolbar editor={editor} onImage={() => fileInput.current?.click()} onLink={editLink} labels={labels} />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="memo-save-button"
              disabled={!memoDocument || !dirty.current || status === 'loading' || status === 'saving' || status === 'conflict'}
              onClick={() => memoDocument && void save(memoDocument.revision)}
              title={t('memo.saveShortcut')}
            >
              <Save aria-hidden="true" />
              <span>{t('common.save')}</span>
            </Button>
          </div>
          {imageNotice ? <div className="memo-image-notice" role="alert">{t(`memo.imageError.${imageNotice}`)}</div> : null}
          <div className="memo-editor-shell__canvas" data-testid="memo-editor-canvas">
            {status === 'loading' ? <div className="memo-editor-loading" aria-hidden="true"><span /><span /><span /></div> : null}
            <EditorContent editor={editor} className="memo-editor" />
          </div>
          <footer className="memo-editor-footer">
            <span>{t('memo.words', { count: wordCount })}</span>
            <span aria-hidden="true">·</span>
            <span>{t('memo.characters', { count: plainText.length })}</span>
            <span className="memo-editor-footer__hint">{t('memo.saveShortcut')}</span>
          </footer>
        </ProductPanel>
      </ProductPageBody>
    </ProductPage>
  )
}
