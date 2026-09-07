/**
 * Deterministic redaction helpers for anything that leaves process memory:
 * artifacts, exports, log lines. Redaction is part of persistence, not an
 * optional layer.
 */

export type RedactionSummary = {
  redacted: boolean
  rules: readonly string[]
  truncated: boolean
}

export type RedactionOptions = {
  maxStringLength?: number
  workspaceRoot?: string
}

const DEFAULT_MAX_STRING_LENGTH = 20000
const REDACTED = '[redacted]'
const TRUNCATED = '[truncated]'

export function redactForPersistence(
  value: unknown,
  options: RedactionOptions = {},
): { value: unknown; summary: RedactionSummary } {
  const rules = new Set<string>()
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH

  function visit(input: unknown): unknown {
    if (typeof input === 'string') {
      let out = redactString(input, options.workspaceRoot, rules)
      if (out.length > maxStringLength) {
        out = `${out.slice(0, maxStringLength)}\n${TRUNCATED} ${out.length - maxStringLength} chars omitted`
        rules.add('truncate.large_string')
      }
      return out
    }
    if (input === null || typeof input !== 'object') return input
    if (Array.isArray(input)) return input.map((item) => visit(item))

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
      const lower = key.toLowerCase()
      if (isSecretKey(lower)) {
        out[key] = REDACTED
        rules.add('secret.key')
        continue
      }
      if (isUrlKey(lower)) {
        out[key] = typeof child === 'string' ? redactUrl(child, rules) : child
        continue
      }
      out[key] = visit(child)
    }
    return out
  }

  const next = visit(value)
  return {
    value: next,
    summary: {
      redacted: rules.size > 0,
      rules: [...rules].sort(),
      truncated: rules.has('truncate.large_string'),
    },
  }
}

function isSecretKey(lowerKey: string): boolean {
  return (
    lowerKey === 'authorization' ||
    lowerKey === 'x-api-key' ||
    lowerKey === 'api-key' ||
    lowerKey === 'apikey' ||
    lowerKey === 'api_key' ||
    lowerKey === 'token' ||
    lowerKey === 'access_token' ||
    lowerKey === 'refresh_token' ||
    lowerKey === 'password' ||
    lowerKey === 'secret' ||
    lowerKey.endsWith('_key') ||
    lowerKey.endsWith('_token') ||
    lowerKey.endsWith('-key') ||
    lowerKey.endsWith('-token')
  )
}

function isUrlKey(lowerKey: string): boolean {
  return lowerKey === 'url' || lowerKey === 'baseurl' || lowerKey === 'apiurl' || lowerKey.endsWith('url') || lowerKey.endsWith('_url')
}

function redactString(input: string, workspaceRoot: string | undefined, rules: Set<string>): string {
  let out = input
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, () => {
    rules.add('secret.bearer')
    return '******'
  })
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, () => {
    rules.add('secret.openai_key')
    return REDACTED
  })
  out = out.replace(/(ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY|TOKEN)=([^\s]+)/g, (_m, name) => {
    rules.add('secret.env')
    return `${name}=${REDACTED}`
  })
  if (workspaceRoot && out.includes(workspaceRoot)) {
    out = out.split(workspaceRoot).join('<workspace>')
    rules.add('path.workspace_root')
  }
  return out
}

function redactUrl(input: string, rules: Set<string>): string {
  try {
    const parsed = new URL(input)
    rules.add('url.base')
    return `<${parsed.protocol}//redacted>${parsed.pathname}${parsed.search ? '?<query-redacted>' : ''}`
  } catch {
    return input
  }
}
