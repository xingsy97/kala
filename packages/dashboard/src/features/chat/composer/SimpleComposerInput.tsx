import { useCallback, useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'

import { cn } from '../../../lib/utils.js'

export type SimpleComposerImage = {
  id: string
  dataUrl: string
}

type Props = {
  text: string
  images: readonly SimpleComposerImage[]
  disabled?: boolean
  placeholder?: string
  onTextChange(next: string): void
  onRemoveImage(id: string): void
  onPaste?(e: ClipboardEvent<HTMLDivElement>): void
  onEnterSubmit?(): void
  onSelectionChange?(caret: number): void
  ariaLabel?: string
}

const IMAGE_ATTR = 'data-ak-img-id'
const CARET_MARKER = '​'

function serializeDom(root: HTMLElement): { text: string; imageIds: string[]; caret: number | null } {
  let text = ''
  let caret: number | null = null
  const imageIds: string[] = []
  let imageIndex = 0

  const selection = typeof window !== 'undefined' ? window.getSelection() : null
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  const caretNode = range ? range.startContainer : null
  const caretOffset = range ? range.startOffset : 0

  function walk(node: Node): void {
    if (node === caretNode && caret === null) {
      caret = text.length + (node.nodeType === Node.TEXT_NODE ? Math.min(caretOffset, (node.textContent ?? '').length) : 0)
    }
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const imgId = el.getAttribute(IMAGE_ATTR)
    if (imgId) {
      imageIds.push(imgId)
      imageIndex += 1
      return
    }
    if (el.tagName === 'BR') {
      text += '\n'
      return
    }
    const isBlock = el.tagName === 'DIV' || el.tagName === 'P'
    const startedAt = text.length
    for (const child of Array.from(el.childNodes)) walk(child)
    if (isBlock && text.length > startedAt && !text.endsWith('\n')) {
      const parent = el.parentElement
      if (parent && parent !== root) return
      const isLastChild = el === root.lastChild
      if (!isLastChild) text += '\n'
    }
  }

  for (const child of Array.from(root.childNodes)) walk(child)
  void imageIndex
  return { text, imageIds, caret }
}

function buildDom(root: HTMLElement, text: string, images: readonly SimpleComposerImage[]): void {
  root.innerHTML = ''
  const lines = text.split('\n')
  lines.forEach((line, idx) => {
    if (line.length > 0) root.appendChild(document.createTextNode(line))
    if (idx < lines.length - 1) root.appendChild(document.createElement('br'))
  })
  images.forEach((img, i) => {
    root.appendChild(document.createTextNode(' '))
    const span = document.createElement('span')
    span.setAttribute(IMAGE_ATTR, img.id)
    span.setAttribute('contenteditable', 'false')
    span.setAttribute('role', 'img')
    span.setAttribute('aria-label', `Image #${i + 1}`)
    span.dataset.akTokenIndex = String(i + 1)
    span.className = 'ak-composer-token'
    span.textContent = `[Image #${i + 1}]`
    root.appendChild(span)
  })
  if (root.childNodes.length === 0) {
    root.appendChild(document.createTextNode(CARET_MARKER))
  }
}

function placeCaretAtEnd(root: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

export function SimpleComposerInput({
  text,
  images,
  disabled,
  placeholder,
  onTextChange,
  onRemoveImage,
  onPaste,
  onEnterSubmit,
  onSelectionChange,
  ariaLabel,
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const lastSerialized = useRef<{ text: string; imageIds: string[] }>({ text: '', imageIds: [] })
  const suppressNextInput = useRef(false)

  const syncDomFromProps = useCallback((): void => {
    const el = ref.current
    if (!el) return
    const currentIds = images.map((i) => i.id)
    const domNeedsRebuild =
      lastSerialized.current.text !== text ||
      lastSerialized.current.imageIds.length !== currentIds.length ||
      lastSerialized.current.imageIds.some((id, i) => currentIds[i] !== id)
    if (!domNeedsRebuild) return
    const hadFocus = document.activeElement === el
    suppressNextInput.current = true
    buildDom(el, text, images)
    lastSerialized.current = { text, imageIds: currentIds }
    if (hadFocus) placeCaretAtEnd(el)
  }, [text, images])

  useLayoutEffect(() => {
    syncDomFromProps()
  }, [syncDomFromProps])

  const handleInput = useCallback((): void => {
    const el = ref.current
    if (!el) return
    if (suppressNextInput.current) {
      suppressNextInput.current = false
      return
    }
    const { text: nextText, imageIds, caret } = serializeDom(el)
    const cleanText = nextText.replace(new RegExp(CARET_MARKER, 'g'), '')
    const previousIds = new Set(images.map((i) => i.id))
    const currentIds = new Set(imageIds)
    for (const id of previousIds) {
      if (!currentIds.has(id)) onRemoveImage(id)
    }
    lastSerialized.current = { text: cleanText, imageIds }
    if (cleanText !== text) onTextChange(cleanText)
    if (caret !== null && onSelectionChange) onSelectionChange(caret)
  }, [images, onRemoveImage, onTextChange, onSelectionChange, text])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onEnterSubmit?.()
    }
  }, [onEnterSubmit])

  const handlePaste = useCallback((e: ClipboardEvent<HTMLDivElement>): void => {
    if (onPaste) {
      onPaste(e)
      if (e.defaultPrevented) return
    }
    e.preventDefault()
    const plain = e.clipboardData?.getData('text/plain') ?? ''
    if (!plain) return
    document.execCommand('insertText', false, plain)
  }, [onPaste])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (text.length === 0 && images.length === 0) {
      el.setAttribute('data-empty', 'true')
    } else {
      el.removeAttribute('data-empty')
    }
  }, [text, images])

  return (
    <div
      ref={ref}
      contentEditable={disabled ? false : true}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      data-placeholder={placeholder ?? ''}
      data-testid="composer-input-simple"
      className={cn(
        'ak-composer-simple w-full whitespace-pre-wrap break-words rounded-2xl border border-border/60 bg-background/60 px-4 py-2.5 text-base leading-relaxed outline-none transition-colors sm:text-sm',
        'focus-within:border-border focus-within:bg-background focus-within:ring-1 focus-within:ring-ring/40',
        'min-h-[38px] max-h-[calc(1.5rem*5+1.25rem)] overflow-y-auto',
        disabled ? 'cursor-not-allowed opacity-60' : '',
      )}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    />
  )
}
