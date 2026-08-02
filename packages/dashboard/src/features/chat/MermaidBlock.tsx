import { memo, useEffect, useId, useState } from 'react'

import { CodeBlock } from './CodeBlock.js'

export const MermaidBlock = memo(function MermaidBlock({ code, deferRender = false }: { code: string; deferRender?: boolean }): JSX.Element {
  const reactId = useId()
  const [result, setResult] = useState<{ svg: string } | { error: true } | null>(null)

  useEffect(() => {
    if (deferRender || !code.trim()) {
      setResult(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
          flowchart: { htmlLabels: false },
          suppressErrorRendering: true,
        })
        const id = `ak-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/gu, '')}`
        const rendered = await mermaid.render(id, code)
        if (!cancelled) setResult({ svg: rendered.svg })
      } catch {
        if (!cancelled) setResult({ error: true })
      }
    })()
    return () => { cancelled = true }
  }, [code, deferRender, reactId])

  if (result && 'svg' in result) {
    return (
      <div
        className="my-3 max-w-full overflow-x-auto rounded-lg border border-border/60 bg-card p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        data-testid="mermaid-diagram"
        role="img"
        aria-label="Mermaid diagram"
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

  return <CodeBlock code={code} lang="mermaid" deferEnhancement />
})
