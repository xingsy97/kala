import {
  TrialTraceSchema,
  parseTrialTraceJsonl,
  serializeTrialTraceJsonl,
  type TrialTrace,
} from '@agent-kernel/eval-protocol'

type SpanInput = {
  spanId: string
  name: 'analyzer.detect' | 'reproduction.verify'
  startedAt: string
  completedAt: string
  status: 'ok' | 'error'
  artifactRefs?: readonly string[]
  outcomeCategory: string
}

export function appendTraceSpans(sourceJsonl: string, additions: readonly SpanInput[]): TrialTrace {
  const source = parseTrialTraceJsonl(sourceJsonl)
  const trial = source.spans.find((span) => span.name === 'evaluation.trial')
  if (!trial) throw new Error('source trace has no evaluation.trial parent')
  const refs = trial.refs
  const existingIds = new Set(source.spans.map((span) => span.spanId))
  const spans = [...source.spans]
  for (const addition of additions) {
    const spanId = uniqueSpanId(safeId(addition.spanId), existingIds)
    existingIds.add(spanId)
    spans.push({
      schemaVersion: 1, traceId: source.traceId, spanId, parentSpanId: trial.spanId, name: addition.name,
      startedAt: addition.startedAt, completedAt: Date.parse(addition.completedAt) < Date.parse(addition.startedAt) ? addition.startedAt : addition.completedAt,
      status: addition.status, refs, artifactRefs: [...(addition.artifactRefs ?? [])], outcomeCategory: addition.outcomeCategory,
    })
  }
  return TrialTraceSchema.parse({ ...source, spans })
}

export function traceJsonl(trace: TrialTrace): string { return serializeTrialTraceJsonl(trace) }

function uniqueSpanId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base
  let suffix = 2
  while (existing.has(base + '-' + String(suffix))) suffix += 1
  return base + '-' + String(suffix)
}
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 240) || 'derived-span' }
