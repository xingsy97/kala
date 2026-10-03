import { memo, useEffect, useId, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ReadonlySvgPreviewDialog } from '../../components/ReadonlyImagePreview.js'
import { CodeBlock } from './CodeBlock.js'

let mermaidModule: Promise<(typeof import('mermaid'))['default']> | null = null
let mermaidRenderQueue = Promise.resolve()
const mermaidSvgCache = new Map<string, string>()

function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
  mermaidModule ??= import('mermaid').then(({ default: mermaid }) => mermaid)
  return mermaidModule
}

export const MermaidBlock = memo(function MermaidBlock({ code, deferRender = false }: { code: string; deferRender?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const reactId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === 'undefined')
  const [result, setResult] = useState<{ svg: string } | { error: true } | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !rootRef.current) {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setNearViewport(true)
      observer.disconnect()
    }, { rootMargin: '400px' })
    observer.observe(rootRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (deferRender || !nearViewport || !code.trim()) {
      setResult(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'default'
        const cacheKey = `${theme}\u0000${code}`
        const cached = mermaidSvgCache.get(cacheKey)
        if (cached) {
          if (!cancelled) setResult({ svg: cached })
          return
        }
        const mermaid = await loadMermaid()
        const id = `ak-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/gu, '')}`
        let svg = ''
        const render = async (): Promise<void> => {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, flowchart: { htmlLabels: false }, suppressErrorRendering: true })
          svg = (await mermaid.render(id, code)).svg
        }
        mermaidRenderQueue = mermaidRenderQueue.then(render, render)
        await mermaidRenderQueue
        mermaidSvgCache.set(cacheKey, svg)
        if (!cancelled) setResult({ svg })
      } catch {
        if (!cancelled) setResult({ error: true })
      }
    })()
    return () => { cancelled = true }
  }, [code, deferRender, nearViewport, reactId])

  if (result && 'svg' in result) {
    return (
      <>
        <button
          type="button"
          className="group relative my-3 block w-full max-w-full cursor-zoom-in overflow-x-auto rounded-lg border border-border/60 bg-card p-3 text-left transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          data-testid="mermaid-diagram"
          aria-label={t('chatCommon.openMermaidDiagram')}
          onClick={() => setPreviewOpen(true)}
        >
          <span className="pointer-events-none absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md bg-background/85 text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Maximize2 className="h-4 w-4" aria-hidden="true" />
          </span>
          <span role="img" aria-label={t('chatCommon.mermaidDiagram')} dangerouslySetInnerHTML={{ __html: result.svg }} />
        </button>
        <ReadonlySvgPreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          svg={result.svg}
          alt={t('chatCommon.mermaidDiagram')}
          title={t('chatCommon.mermaidDiagram')}
          dialogTestId="mermaid-preview-dialog"
          imageTestId="mermaid-preview-image"
        />
      </>
    )
  }

  if (result && 'error' in result) {
    return (
      <div data-testid="mermaid-error" className="my-3">
        <div className="mb-1 text-xs text-muted-foreground">Diagram could not be rendered. Showing source.</div>
        <CodeBlock code={code} lang="mermaid" />
      </div>
    )
  }

  return <div ref={rootRef}><CodeBlock code={code} lang="mermaid" deferEnhancement /></div>
})
