/**
 * CodeBlock — replaces the plain `<pre>` inside AssistantMarkdown /
 * NestedMarkdown with a shiki-highlighted version. Progressive: shows
 * the raw code immediately, then swaps in the highlighted HTML once
 * shiki resolves (usually one microtask, but longer on first grammar
 * fetch).
 *
 * Dual-theme rendering
 * --------------------
 * See lib/shiki.ts. The rendered spans carry both `--shiki-light` and
 * `--shiki-dark` CSS variables; global CSS picks the right one based on
 * `.dark` on `html`, so theme flips are instant.
 */

import { memo, useEffect, useState, type ReactNode } from 'react'

import { cn } from '../../lib/utils.js'
import { scheduleDeferredWork } from '../../lib/deferred-work.js'

type Props = {
  code: string
  lang?: string
  className?: string
  trailingSlot?: ReactNode
  /** Keep the live fence as stable raw text; enhance only after it is complete. */
  deferEnhancement?: boolean
}

function extractHighlightedCodeHtml(html: string): string {
  const match = html.match(/<code[^>]*>([\s\S]*)<\/code>/iu)
  return match?.[1] ?? html
}

export const CodeBlock = memo(function CodeBlock({ code, lang, className, trailingSlot, deferEnhancement = false }: Props): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (!lang || deferEnhancement) {
      setHtml(null)
      return
    }
    let cancelled = false
    const deferred = scheduleDeferredWork(() => {
      // Keep the mounted <pre> stable. Shiki HTML is applied inside it rather
      // than swapping a raw <pre> for a wrapper subtree; the old swap was a
      // visible remount immediately after a streamed fence committed.
      void import('../../lib/shiki.js').then(({ highlightToHtml }) => highlightToHtml(code, lang)).then((result) => {
        if (!cancelled) setHtml(result)
      })
    })
    return () => {
      cancelled = true
      deferred.cancel()
    }
  }, [code, deferEnhancement, lang])

  return (
    <pre
      data-testid={html ? 'code-block-highlighted' : 'code-block-raw'}
      data-lang={lang ?? ''}
      className={cn(
        'my-3 max-w-full overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 text-xs text-foreground',
        html && 'shiki-host',
        className,
      )}
    >
      {html
        ? <code dangerouslySetInnerHTML={{ __html: extractHighlightedCodeHtml(html) }} />
        : <code>{code}{trailingSlot}</code>}
    </pre>
  )
})
