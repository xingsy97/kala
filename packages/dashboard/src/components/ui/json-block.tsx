import { useEffect, useState } from 'react'
import { Check, ChevronsDownUp, ChevronsUpDown, Copy, Search, X } from 'lucide-react'
import JsonView from '@uiw/react-json-view'
import { githubDarkTheme } from '@uiw/react-json-view/githubDark'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import { useTranslation } from 'react-i18next'

import { cn } from '../../lib/utils.js'
import { ScrollArea } from './scroll-area.js'

type Props = {
  value: unknown
  label?: string
  collapsed?: number | boolean
  className?: string
}

// Standard JSON tree renderer for the dashboard. Wraps @uiw/react-json-view
// so every consumer gets the same dark/light palette, a copy button, and
// consistent typography. Do not build another JSON tree elsewhere.
export function JsonBlock({
  value,
  label,
  collapsed = 2,
  className,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  )
  const jsonText = safeJsonStringify(value)
  const summary = summarizeJsonValue(value)
  const matches = query.trim() ? countMatches(jsonText, query.trim()) : 0

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setDark(root.classList.contains('dark'))
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  return (
    <div
      className={cn(
        'rounded border border-border/50 overflow-hidden bg-muted/40',
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 text-xs text-muted-foreground">
        <span className="flex-1 truncate font-medium">{label ?? 'json'}</span>
        <span className="hidden flex-none rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline" data-testid="json-block-summary">
          {summary}
        </span>
        <label className="flex min-w-0 flex-none items-center gap-1 rounded bg-background/70 px-1.5 py-0.5 ring-1 ring-border/40 focus-within:ring-primary/40">
          <Search className="h-3 w-3 flex-none" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('jsonBlock.search')}
            className="h-5 w-24 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground sm:w-32"
            aria-label={t('jsonBlock.searchJson')}
            data-testid="json-block-search"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} aria-label={t('jsonBlock.clearSearch')} className="rounded hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </label>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs normal-case tracking-normal text-muted-foreground hover:text-foreground hover:bg-accent"
          aria-label={expanded ? t('jsonBlock.collapseAllJson') : t('jsonBlock.expandAllJson')}
        >
          {expanded ? (
            <>
              <ChevronsDownUp className="h-3.5 w-3.5" />
              {t('jsonBlock.collapseAll')}
            </>
          ) : (
            <>
              <ChevronsUpDown className="h-3.5 w-3.5" />
              {t('jsonBlock.expandAll')}
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs normal-case tracking-normal text-muted-foreground hover:text-foreground hover:bg-accent"
          aria-label={t('jsonBlock.copyJson')}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-500" />
              {t('jsonBlock.copied')}
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              {t('jsonBlock.copy')}
            </>
          )}
        </button>
      </div>
      {query.trim() ? (
        <div className="sticky top-0 z-10 border-b border-border/40 bg-background/95 px-3 py-1.5 text-xs text-muted-foreground" data-testid="json-block-search-status">
          {matches > 0 ? t('jsonBlock.match', { count: matches }) : t('jsonBlock.noMatches')}
        </div>
      ) : null}
      <ScrollArea
        className="max-h-96 text-sm [&>[data-radix-scroll-area-viewport]]:max-h-96"
        data-testid="json-block-scrollarea"
      >
        <div className="p-3">
        <JsonView
          key={`${dark ? 'dark' : 'light'}-${expanded ? 'expanded' : 'collapsed'}`}
          value={value as object}
          style={dark ? githubDarkTheme : githubLightTheme}
          collapsed={expanded ? false : collapsed}
          displayDataTypes={false}
          displayObjectSize={false}
          enableClipboard={false}
          shortenTextAfterLength={200}
        />
        </div>
      </ScrollArea>
    </div>
  )
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function summarizeJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `array ${value.length}`
  if (value && typeof value === 'object') return `object ${Object.keys(value as Record<string, unknown>).length}`
  if (typeof value === 'string') return `string ${value.length}`
  if (typeof value === 'number' || typeof value === 'boolean') return typeof value
  if (value === null) return 'null'
  return 'value'
}

function countMatches(text: string, query: string): number {
  if (!query) return 0
  const haystack = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  let count = 0
  let index = 0
  while (true) {
    const next = haystack.indexOf(needle, index)
    if (next === -1) return count
    count += 1
    index = next + Math.max(1, needle.length)
  }
}
