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

import { Check, Copy } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
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

function splitHighlightedLines(html: string): string[] {
  if (typeof document === 'undefined') return []
  const template = document.createElement('template')
  template.innerHTML = extractHighlightedCodeHtml(html)
  const lines = Array.from(template.content.querySelectorAll('.line')).map((line) => line.innerHTML)
  return lines.length ? lines : [template.innerHTML]
}

export const CodeBlock = memo(function CodeBlock({ code, lang, className, trailingSlot, deferEnhancement = false }: Props): JSX.Element {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const language = languageLabel(lang)
  const rawLines = useMemo(() => code.split('\n'), [code])
  const visualLineCount = Math.max(1, rawLines.length)
  const highlightedLines = useMemo(() => (html ? splitHighlightedLines(html) : null), [html])

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

  const copyCode = useCallback(() => {
    if (!navigator.clipboard?.writeText) return
    void (async () => {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })()
  }, [code])

  return (
    <figure
      className={cn(
        'ak-code-snippet my-3 max-w-full overflow-hidden rounded-2xl border border-border/55 bg-card/95 text-foreground shadow-sm',
        html && 'shiki-host',
        className,
      )}
      data-lang={lang ?? ''}
      data-testid="code-snippet"
    >
      <figcaption className="ak-code-snippet-header flex h-7 items-center justify-between gap-2 border-b border-border/40 px-2">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_0_2px_hsl(142_76%_36%/0.10)]" aria-hidden />
          <span className="truncate font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground" data-testid="code-block-language">{language}</span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-5 gap-1 bg-background/55 px-1.5 text-[0.625rem] text-muted-foreground shadow-none hover:text-foreground"
          onClick={copyCode}
          aria-label={t('codeBlock.copy')}
          data-testid="code-block-copy"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-500" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          {copied ? t('codeBlock.copied') : t('codeBlock.copy')}
        </Button>
      </figcaption>
      <div className="ak-code-snippet-body overflow-x-auto">
        <pre
          data-testid={html ? 'code-block-highlighted' : 'code-block-raw'}
          data-lang={lang ?? ''}
          className="ak-code-lines m-0 min-w-full overflow-visible bg-transparent py-2.5 font-mono text-xs leading-5 text-foreground"
        >
          <code className="block min-w-full">
            {Array.from({ length: Math.max(visualLineCount, highlightedLines?.length ?? 0) }, (_, index) => {
              const highlighted = highlightedLines?.[index]
              const raw = rawLines[index] ?? ''
              const isLastLine = index === visualLineCount - 1
              return (
                <span className="ak-code-line" key={index} data-testid="code-line">
                  <span className="ak-code-line-number" aria-hidden data-testid="code-line-gutter">{index + 1}</span>
                  <span className="ak-code-line-content">
                    {highlightedLines
                      ? <span dangerouslySetInnerHTML={{ __html: highlighted && highlighted.length ? highlighted : '&nbsp;' }} />
                      : <>{raw || '\u00a0'}{isLastLine ? trailingSlot : null}</>}
                  </span>
                </span>
              )
            })}
          </code>
        </pre>
      </div>
    </figure>
  )
})

function languageLabel(lang: string | undefined): string {
  const value = lang?.trim()
  if (!value) return 'text'
  const aliases: Record<string, string> = {
    js: 'JavaScript',
    javascript: 'JavaScript',
    jsx: 'JSX',
    ts: 'TypeScript',
    typescript: 'TypeScript',
    tsx: 'TSX',
    py: 'Python',
    rb: 'Ruby',
    rs: 'Rust',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    yml: 'YAML',
    yaml: 'YAML',
    json: 'JSON',
    md: 'Markdown',
    markdown: 'Markdown',
    html: 'HTML',
    css: 'CSS',
    sql: 'SQL',
  }
  return aliases[value.toLowerCase()] ?? value
}
