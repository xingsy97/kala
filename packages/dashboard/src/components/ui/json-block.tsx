import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import JsonView from '@uiw/react-json-view'
import { githubDarkTheme } from '@uiw/react-json-view/githubDark'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'

import { cn } from '../../lib/utils.js'

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
  const [copied, setCopied] = useState(false)
  const dark = document.documentElement.classList.contains('dark')

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
        'rounded border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50 dark:bg-slate-900/60',
        className,
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1 border-b border-slate-200 dark:border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
        <span className="flex-1 truncate">{label ?? 'json'}</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-800"
          aria-label="copy JSON"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-500" />
              copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              copy
            </>
          )}
        </button>
      </div>
      <div className="max-h-96 overflow-auto p-2 text-xs">
        <JsonView
          value={value as object}
          style={dark ? githubDarkTheme : githubLightTheme}
          collapsed={collapsed}
          displayDataTypes={false}
          displayObjectSize={false}
          enableClipboard={false}
          shortenTextAfterLength={200}
        />
      </div>
    </div>
  )
}
