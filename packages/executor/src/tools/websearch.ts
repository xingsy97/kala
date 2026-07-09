import type { Tool } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { optionalPositiveInt, requireString } from './schema.js'

const DUCKDUCKGO_HTML = 'https://html.duckduckgo.com/html/'
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const SNIPPET_MAX_CHARS = 500

type SearchResult = {
  title: string
  url: string
  snippet: string
}

export const websearchTool: Tool = {
  name: 'websearch',
  async run(input, ctx) {
    const query = requireString(input, 'query').trim()
    if (query.length === 0) {
      throw new ToolError('EINVAL', 'query must be non-empty')
    }
    const requested = optionalPositiveInt(input, 'limit') ?? DEFAULT_LIMIT
    const limit = Math.min(requested, MAX_LIMIT)

    throwIfAborted(ctx)

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    let html: string
    try {
      const url = `${DUCKDUCKGO_HTML}?${new URLSearchParams({ q: query, kl: 'wt-wt' })}`
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new ToolError('EHTTP', `DuckDuckGo returned HTTP ${res.status}`)
      }
      html = await res.text()
    } catch (err) {
      if (controller.signal.aborted && !ctx.signal.aborted) {
        throw new ToolError('ETIMEDOUT', `search timed out after ${DEFAULT_TIMEOUT_MS}ms`)
      }
      throwIfAborted(ctx)
      if (err instanceof ToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new ToolError('ENETWORK', `search failed: ${msg}`)
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }

    const results = parseDuckDuckGoHtml(html, limit)
    if (results.length === 0) {
      return `No results for: ${query}`
    }
    return formatResults(query, results)
  },
}

/**
 * Parse the DuckDuckGo HTML result page. Each result is inside a
 * `<div class="result ...">` block containing an `<a class="result__a">`
 * (title + href) and a `<a class="result__snippet">` (snippet text). We use
 * loose regex extraction rather than a full HTML parser to avoid a dependency;
 * DuckDuckGo's HTML endpoint is stable and the structure is simple.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const anchorRe =
    /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe =
    /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g

  const anchors: { href: string; title: string; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1]
    const rawTitle = m[2]
    if (href === undefined || rawTitle === undefined) continue
    anchors.push({ href, title: stripHtml(rawTitle), index: m.index })
  }
  const snippets: { text: string; index: number }[] = []
  while ((m = snippetRe.exec(html)) !== null) {
    const rawText = m[1]
    if (rawText === undefined) continue
    snippets.push({ text: stripHtml(rawText), index: m.index })
  }

  for (const anchor of anchors) {
    if (results.length >= limit) break
    const url = normalizeDuckDuckGoUrl(anchor.href)
    if (!url) continue
    const nextSnippet = snippets.find(
      (s) => s.index > anchor.index && s.index - anchor.index < 4000,
    )
    const snippetRaw = nextSnippet?.text ?? ''
    const snippet =
      snippetRaw.length > SNIPPET_MAX_CHARS
        ? snippetRaw.slice(0, SNIPPET_MAX_CHARS) + '…'
        : snippetRaw
    results.push({ title: anchor.title, url, snippet })
  }
  return results
}

/**
 * DuckDuckGo wraps outbound links in `//duckduckgo.com/l/?uddg=<encoded>` or
 * `/l/?uddg=<encoded>` redirects. Unwrap those so the LLM sees the real URL.
 */
function normalizeDuckDuckGoUrl(href: string): string | null {
  if (!href) return null
  let raw = href.trim()
  if (raw.startsWith('//')) raw = 'https:' + raw
  try {
    const u = new URL(raw, 'https://duckduckgo.com')
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg')
      if (target) return decodeURIComponent(target)
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString()
    return null
  } catch {
    return null
  }
}

function stripHtml(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

function formatResults(query: string, results: readonly SearchResult[]): string {
  const header = `Web search results for: ${query}`
  const body = results
    .map((r, i) => {
      const parts = [`${i + 1}. ${r.title || '(no title)'}`, `   ${r.url}`]
      if (r.snippet) parts.push(`   ${r.snippet}`)
      return parts.join('\n')
    })
    .join('\n\n')
  return `${header}\n\n${body}`
}
