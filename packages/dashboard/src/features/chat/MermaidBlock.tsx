import { memo, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
      <div
        className="my-3 max-w-full overflow-x-auto rounded-lg border border-border/60 bg-card p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        data-testid="mermaid-diagram"
        role="img"
        aria-label={t('chatCommon.mermaidDiagram')}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
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
