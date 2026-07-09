import type { Tool } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { optionalPositiveInt, requireString } from './schema.js'

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_CHARS = 12_000
const MAX_CHARS = 50_000

export const webfetchTool: Tool = {
  name: 'webfetch',
  async run(input, ctx) {
    const url = normalizeUrl(requireString(input, 'url'))
    const maxChars = Math.min(optionalPositiveInt(input, 'maxChars') ?? DEFAULT_MAX_CHARS, MAX_CHARS)

    throwIfAborted(ctx)

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new ToolError('EHTTP', `fetch returned HTTP ${res.status}`)
      }
      const archiveText = await fetchArchiveOrgText(url, controller.signal)
      const contentType = res.headers.get('content-type') ?? ''
      if (isPdfResponse(url, contentType) && !archiveText) {
        return `Fetched: ${url}\nContent-Type: ${contentType || 'unknown'}\n\nPDF content was not extracted as readable text. Use a text/OCR endpoint, an HTML landing page, a repository metadata page, or a focused web search for the title and key terms instead of treating this binary PDF response as evidence.`
      }
      const raw = await res.text()
      const text = contentType.includes('text/html') || looksLikeHtml(raw)
        ? htmlToText(raw)
        : raw
      const combined = archiveText
        ? `${archiveText.header}\n\n${archiveText.text}\n\n--- Archive.org landing page text ---\n\n${text}`
        : text
      const cleaned = combined.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      const truncated = cleaned.length > maxChars
        ? `${cleaned.slice(0, maxChars)}\n\n[truncated to ${maxChars} chars]`
        : cleaned
      return `Fetched: ${url}\nContent-Type: ${contentType || 'unknown'}\n\n${truncated}`
    } catch (err) {
      if (controller.signal.aborted && !ctx.signal.aborted) {
        throw new ToolError('ETIMEDOUT', `fetch timed out after ${DEFAULT_TIMEOUT_MS}ms`)
      }
      throwIfAborted(ctx)
      if (err instanceof ToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new ToolError('ENETWORK', `fetch failed: ${msg}`)
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  },
}

async function fetchArchiveOrgText(url: string, signal: AbortSignal): Promise<{ header: string; text: string } | null> {
  const identifier = archiveOrgIdentifier(url)
  if (!identifier) return null

  const candidates = [
    `https://archive.org/stream/${identifier}/${identifier}_djvu.txt`,
    `https://archive.org/download/${identifier}/${identifier}_djvu.txt`,
  ]
  for (const candidate of candidates) {
    const text = await tryFetchText(candidate, signal)
    if (text && !looksLikeHtml(text)) {
      return { header: `Archive.org OCR text: ${candidate}`, text }
    }
  }

  const metadata = await tryFetchJson(`https://archive.org/metadata/${identifier}`, signal)
  const files = Array.isArray(metadata?.files) ? metadata.files : []
  const file = files.find((item) => {
    const name = typeof item?.name === 'string' ? item.name : ''
    return name.endsWith('_djvu.txt') || name.endsWith('_text.txt') || name.endsWith('.txt')
  })
  const name = typeof file?.name === 'string' ? file.name : ''
  if (!name) return null
  const metadataCandidate = `https://archive.org/download/${identifier}/${encodeURIComponent(name).replaceAll('%2F', '/')}`
  const text = await tryFetchText(metadataCandidate, signal)
  return text && !looksLikeHtml(text)
    ? { header: `Archive.org OCR text: ${metadataCandidate}`, text }
    : null
}

function archiveOrgIdentifier(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!/(^|\.)archive\.org$/i.test(url.hostname)) return null
  const parts = url.pathname.split('/').filter(Boolean)
  const marker = parts.findIndex((part) => ['details', 'stream', 'download'].includes(part))
  const identifier = marker >= 0 ? parts[marker + 1] : null
  return identifier && /^[A-Za-z0-9_.-]+$/.test(identifier) ? identifier : null
}

async function tryFetchText(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/plain,text/*;q=0.9,*/*;q=0.5',
      },
      signal,
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function tryFetchJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const raw = await tryFetchText(url, signal)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new ToolError('EINVAL', 'url must be absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('EINVAL', 'url must use http or https')
  }
  return url.toString()
}

function looksLikeHtml(raw: string): boolean {
  return /<\s*(html|body|main|article|div|p|table|title)\b/i.test(raw)
}

function isPdfResponse(url: string, contentType: string): boolean {
  return /application\/pdf/i.test(contentType) || /\.pdf(?:[?#]|$)/i.test(url)
}

export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
  const withBreaks = withoutScripts
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, '\t')
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
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
