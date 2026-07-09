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
import { highlightToHtml } from '../../lib/shiki.js'

type Props = {
  code: string
  lang?: string
  className?: string
  trailingSlot?: ReactNode
}

export const CodeBlock = memo(function CodeBlock({ code, lang, className, trailingSlot }: Props): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (!lang) {
      setHtml(null)
      return
    }
    let cancelled = false
    highlightToHtml(code, lang).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  if (html && !trailingSlot) {
    return (
      <div
        data-testid="code-block-highlighted"
        data-lang={lang}
        className={cn('shiki-host my-3 max-w-full overflow-x-auto rounded-lg', className)}
        // shiki produces trusted HTML from the input code text; browsers
        // won't execute anything, but the surrounding wrapper still handles
        // scroll/overflow so we don't leak layout.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <pre
      data-testid="code-block-raw"
      data-lang={lang ?? ''}
      className={cn(
        'my-3 max-w-full overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 text-xs text-foreground',
        className,
      )}
  >
      <code>{code}{trailingSlot}</code>
    </pre>
  )
})
