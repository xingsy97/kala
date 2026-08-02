import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'

import { Button } from '../../components/ui/button.js'
import { sanitizeMemoHtml } from './memo-html.js'

type MemoDocument = { content: string; revision: number; updatedAt: string }

export function MemoPage(): JSX.Element {
  const [memoDocument, setMemoDocument] = useState<MemoDocument | null>(null)
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<'loading' | 'saved' | 'saving' | 'error' | 'conflict'>('loading')
  const editor = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const dirty = useRef(false)
  const contentRef = useRef('')

  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!memoDocument || !dirty.current) return
    setStatus('saving')
    const timer = window.setTimeout(() => { void save(memoDocument.revision) }, 500)
    return () => window.clearTimeout(timer)
  }, [content, memoDocument?.revision])

  const load = async (): Promise<void> => {
    const response = await fetch('/memo', { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) { setStatus('error'); return }
    const next = await response.json() as MemoDocument
    const safe = sanitizeMemoHtml(next.content)
    contentRef.current = safe; setMemoDocument(next); setContent(safe); if (editor.current) editor.current.innerHTML = safe; dirty.current = false; setStatus('saved')
  }
  const save = async (expectedRevision: number): Promise<void> => {
    const savingContent = sanitizeMemoHtml(contentRef.current)
    const response = await fetch('/memo', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: savingContent, expectedRevision }) })
    if (response.status === 409) { setStatus('conflict'); return }
    if (!response.ok) { setStatus('error'); return }
    const next = await response.json() as MemoDocument
    const unchanged = contentRef.current === savingContent
    dirty.current = !unchanged; setMemoDocument(next); setStatus(unchanged ? 'saved' : 'saving')
    if (!unchanged) setContent(contentRef.current)
  }
  const update = (): void => { const next=editor.current?.innerHTML ?? ''; contentRef.current=next; dirty.current=true; setContent(next) }
  const insertImages = async (files: FileList | null): Promise<void> => {
    if (!files || !editor.current) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) continue
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file) })
      const image = window.document.createElement('img'); image.src=dataUrl; image.alt=file.name; image.className='max-w-full rounded-lg border border-border my-2'; editor.current.appendChild(image)
    }
    update()
  }

  return <main className="flex h-full min-h-0 flex-col bg-background" data-testid="memo-page">
    <header className="flex h-12 items-center justify-between border-b px-4">
      <div><h1 className="text-sm font-semibold">Memo</h1><p className="text-[11px] text-muted-foreground">Private notes · autosaved</p></div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {status === 'saving' || status === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        <span>{status === 'saved' ? 'Saved' : status === 'conflict' ? 'Changed on another device — reload' : status === 'error' ? 'Save failed' : status}</span>
        {status === 'conflict' ? <Button size="sm" variant="outline" onClick={() => void load()}>Reload</Button> : null}
      </div>
    </header>
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col p-4 sm:p-8">
      <div className="mb-2 flex items-center gap-2">
        <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void insertImages(event.target.files)} />
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}><ImagePlus className="mr-1.5 h-4 w-4" />Image</Button>
      </div>
      <div ref={editor} contentEditable suppressContentEditableWarning onInput={update} onPaste={(event) => { const files=event.clipboardData.files; if(files.length){event.preventDefault();void insertImages(files)} }} className="min-h-0 flex-1 overflow-y-auto rounded-xl border bg-card p-5 text-sm leading-7 outline-none focus:ring-2 focus:ring-ring [&_img]:max-w-full [&_pre]:overflow-auto" aria-label="Memo editor" />
    </div>
  </main>
}
