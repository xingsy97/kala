/**
 * Parser for the `<sub_agent>` envelope wrapped around child sessions'
 * final text in `tool_result.content`. Format is defined in
 * docs/protocol/wire-protocol.md §4.4 and produced by
 * `packages/host/src/agent-tool.ts`:
 *
 *   <sub_agent
 *     session_id="…"
 *     agent_type="…"    (optional)
 *     status="completed|failed"
 *     turns="N"
 *     duration_ms="N"
 *   >
 *   <result>…</result>  (status=completed)
 *   <error>…</error>    (status=failed)
 *   </sub_agent>
 *
 * The body's `<` and `>` are HTML-entity-escaped; `&` is preserved so
 * entities the child wrote render normally when un-escaped.
 *
 * Returns null for legacy (pre-envelope) tool_result content and for
 * malformed envelopes — callers fall back to the generic ToolCallGroupBlock.
 */

export type SubAgentEnvelope = {
  sessionId: string
  agentType?: string
  status: 'completed' | 'failed'
  turns: number
  durationMs: number
  /** The un-escaped body from `<result>` (completed) or `<error>` (failed). */
  body: string
}

const HEADER_RE = /^<sub_agent\b([\s\S]*?)>/
const RESULT_RE = /<result>([\s\S]*?)<\/result>/
const ERROR_RE = /<error>([\s\S]*?)<\/error>/

export function parseSubAgentEnvelope(content: string): SubAgentEnvelope | null {
  if (typeof content !== 'string') return null
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('<sub_agent')) return null
  const headerMatch = HEADER_RE.exec(trimmed)
  if (!headerMatch) return null
  const attrs = parseAttrs(headerMatch[1] ?? '')
  const sessionId = attrs.session_id
  const status = attrs.status
  if (!sessionId) return null
  if (status !== 'completed' && status !== 'failed') return null
  const turns = numeric(attrs.turns)
  const durationMs = numeric(attrs.duration_ms)
  const bodyMatch = status === 'completed' ? RESULT_RE.exec(trimmed) : ERROR_RE.exec(trimmed)
  const body = bodyMatch ? unescapeEnvelopeBody(bodyMatch[1] ?? '') : ''
  return {
    sessionId,
    ...(attrs.agent_type ? { agentType: attrs.agent_type } : {}),
    status,
    turns,
    durationMs,
    body: body.trim(),
  }
}

const ATTR_RE = /(\w+)="([^"]*)"/g

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(raw)) !== null) {
    out[m[1]!] = unescapeAttr(m[2]!)
  }
  return out
}

function unescapeAttr(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function unescapeEnvelopeBody(v: string): string {
  return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function numeric(v: string | undefined): number {
  if (!v) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
