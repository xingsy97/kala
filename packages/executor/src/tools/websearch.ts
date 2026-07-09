import type { Tool } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { optionalPositiveInt, requireString } from './schema.js'

const DUCKDUCKGO_HTML_ENDPOINTS = [
  'https://duckduckgo.com/html/',
  'https://lite.duckduckgo.com/lite/',
  'https://html.duckduckgo.com/html/',
] as const
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const SNIPPET_MAX_CHARS = 500
const SNIPPET_ELLIPSIS = '...'
const SERPER_SEARCH_URL = 'https://google.serper.dev/search'
const SUSPICIOUS_DOMAIN_PATTERNS = [
  /(?:^|\.)centresportifarthurnaze\.be$/i,
  /(?:^|\.)djtimobeat\.de$/i,
  /(?:^|\.)tadelaktschweiz\.ch$/i,
  /(?:^|\.)devaupe\.de$/i,
  /(?:^|\.)nevix\.com$/i,
  /(?:^|\.)gartenbaucampinari\.de$/i,
  /(?:^|\.)circusevents\.be$/i,
  /(?:^|\.)sirvintuirklentes\.lt$/i,
  /(?:^|\.)bienenmuddi\.de$/i,
  /(?:^|\.)psychomedicalcenter\.it$/i,
] as const

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

    try {
      const results = process.env.SERPER_API_KEY
        ? await searchSerper(query, limit, controller.signal)
        : await searchDuckDuckGo(query, limit, controller.signal)
      const { results: filtered, dropped } = filterLowQualityResults(query, results, limit)
      if (filtered.length === 0) {
        const suffix = dropped.length
          ? `\n\nFiltered ${dropped.length} suspicious low-quality result(s). Try a narrower source-oriented query using official repositories, catalog records, CVs, association pages, or named candidates.`
          : ''
        return `No results for: ${query}${suffix}`
      }
      return formatResults(query, filtered, dropped.length)
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
  },
}

async function searchSerper(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY
  if (!apiKey) return []
  const res = await fetch(SERPER_SEARCH_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ q: query, num: limit }),
    signal,
  })
  if (!res.ok) {
    throw new ToolError('EHTTP', `Serper returned HTTP ${res.status}`)
  }
  const body = await res.json() as {
    organic?: Array<{ title?: unknown; link?: unknown; snippet?: unknown }>
  }
  return (body.organic ?? [])
    .map((item) => ({
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.link === 'string' ? item.link : '',
      snippet: truncateSnippet(typeof item.snippet === 'string' ? item.snippet : ''),
    }))
    .filter((item) => item.title && item.url)
    .slice(0, limit)
}

async function searchDuckDuckGo(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  let html = ''
  let lastStatus: number | undefined
  for (const endpoint of DUCKDUCKGO_HTML_ENDPOINTS) {
    const url = `${endpoint}?${new URLSearchParams({ q: query, kl: 'wt-wt' })}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal,
    })
    lastStatus = res.status
    if (!res.ok && res.status !== 202) {
      if (endpoint === DUCKDUCKGO_HTML_ENDPOINTS[DUCKDUCKGO_HTML_ENDPOINTS.length - 1]) {
        throw new ToolError('EHTTP', `DuckDuckGo returned HTTP ${res.status}`)
      }
      continue
    }
    html = await res.text()
    const results = parseDuckDuckGoHtml(html, limit)
    if (results.length > 0) return results
  }
  if (lastStatus === 202 || looksLikeDuckDuckGoLanding(html)) {
    throw new ToolError('ESEARCH_UNAVAILABLE', 'DuckDuckGo returned a landing/challenge page instead of search results')
  }
  return []
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
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  const snippetRe =
    /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g

  const anchors: { href: string; title: string; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1]
    const rawTitle = m[2]
    if (attrs === undefined || rawTitle === undefined) continue
    const className = getHtmlAttribute(attrs, 'class')
    if (!className || !/\b(?:result__a|result-link)\b/.test(className)) continue
    const href = getHtmlAttribute(attrs, 'href')
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
    const snippet = truncateSnippet(snippetRaw)
    results.push({ title: anchor.title, url, snippet })
  }
  return results
}

function truncateSnippet(snippet: string): string {
  return snippet.length > SNIPPET_MAX_CHARS
    ? snippet.slice(0, SNIPPET_MAX_CHARS - SNIPPET_ELLIPSIS.length) + SNIPPET_ELLIPSIS
    : snippet
}

export function filterLowQualityResults(
  query: string,
  results: readonly SearchResult[],
  limit: number,
): { results: SearchResult[]; dropped: SearchResult[] } {
  const kept: SearchResult[] = []
  const dropped: SearchResult[] = []
  for (const result of results) {
    if (isLowQualitySearchResult(query, result)) dropped.push(result)
    else kept.push(result)
  }
  return { results: kept.slice(0, limit), dropped }
}

function isLowQualitySearchResult(query: string, result: SearchResult): boolean {
  const host = hostOf(result.url)
  if (host && SUSPICIOUS_DOMAIN_PATTERNS.some((pattern) => pattern.test(host))) return true
  if (/\/(?:amphtml|amp|story|local|live|philosophy|hardware|sports|fashion|opinion|video|lifestyle|auto|finance)\//i.test(result.url)
    && /(?:2026|2027|2028)\//.test(result.url)) return true
  const text = `${result.title} ${result.snippet}`
  if (/\b(?:crossword|answers? for|find clues|today'?s top \d+|download high-quality|view \d+)\b/i.test(text)) return true
  return mirrorsQuery(query, text)
}

function mirrorsQuery(query: string, text: string): boolean {
  const queryTerms = meaningfulTerms(query)
  if (queryTerms.length < 6) return false
  const textTerms = new Set(meaningfulTerms(text))
  const overlap = queryTerms.filter((term) => textTerms.has(term)).length
  const ratio = overlap / queryTerms.length
  return overlap >= 6 && ratio >= 0.6
}

function meaningfulTerms(value: string): string[] {
  const stop = new Set(['the', 'and', 'or', 'a', 'an', 'of', 'in', 'to', 'for', 'with', 'as', 'by', 'on', 'at', 'from', 'was', 'were', 'is', 'are', 'who', 'what', 'when', 'where', 'which'])
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .match(/[a-z0-9][a-z0-9'-]{2,}/g)?.filter((term) => !stop.has(term)) ?? []
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname
  } catch {
    return null
  }
}

function getHtmlAttribute(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const m = re.exec(attrs)
  return m?.[1] ?? m?.[2] ?? m?.[3]
}

function looksLikeDuckDuckGoLanding(html: string): boolean {
  return /<link[^>]+rel="canonical"[^>]+href="https:\/\/duckduckgo\.com\//i.test(html)
    && !/\b(result__a|result-link)\b/.test(html)
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

function formatResults(query: string, results: readonly SearchResult[], droppedCount = 0): string {
  const header = `Web search results for: ${query}`
  const body = results
    .map((r, i) => {
      const parts = [`${i + 1}. ${r.title || '(no title)'}`, `   ${r.url}`]
      if (r.snippet) parts.push(`   ${r.snippet}`)
      return parts.join('\n')
    })
    .join('\n\n')
  const footer = droppedCount > 0
    ? `\n\n[filtered ${droppedCount} suspicious low-quality result(s)]`
    : ''
  return `${header}\n\n${body}${footer}`
}
