/**
 * OTLP HTTP exporter for OpenInference/OpenTelemetry GenAI spans.
 *
 * Converts our internal `EnhancementSpan` records into the OTLP/HTTP JSON
 * protobuf shape that collectors (OpenTelemetry Collector, Phoenix, Arize)
 * accept. Two modes are supported:
 *
 *   - `file` — write the OTLP payload to disk. Useful for offline replay and
 *     tests. The dashboard's trace compare view can also load these directly.
 *   - `http` — POST to a collector endpoint. The exporter is best-effort:
 *     it returns success/failure per batch but never blocks the host loop.
 *
 * The exporter never captures credentials in its logs; sensitive headers are
 * expected to be provided by the caller (via `headers`), not written back.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { EnhancementSpan } from '@agent-kernel/shared/enhancement'

export type OtlpAttribute = {
  key: string
  value:
    | { stringValue: string }
    | { boolValue: boolean }
    | { intValue: string }
    | { doubleValue: number }
    | { arrayValue: { values: OtlpAttribute['value'][] } }
}

export type OtlpEvent = {
  timeUnixNano: string
  name: string
  attributes: OtlpAttribute[]
}

export type OtlpSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  status: { code: number; message?: string }
  attributes: OtlpAttribute[]
  events: OtlpEvent[]
}

export type OtlpTraceBundle = {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] }
    scopeSpans: Array<{
      scope: { name: string; version?: string }
      spans: OtlpSpan[]
    }>
  }>
}

export type SpansToOtlpInput = {
  spans: readonly EnhancementSpan[]
  serviceName?: string
  sessionId?: string
  runId?: string
  hostVersion?: string
  scopeName?: string
  scopeVersion?: string
}

const NANO_PER_MS = 1_000_000n

export function spansToOtlp(input: SpansToOtlpInput): OtlpTraceBundle {
  const serviceName = input.serviceName ?? 'agent-kernel-host'
  const scopeName = input.scopeName ?? '@agent-kernel/host'
  const scopeVersion = input.scopeVersion ?? '0.0.0'
  const resourceAttributes: OtlpAttribute[] = [
    { key: 'service.name', value: { stringValue: serviceName } },
  ]
  if (input.hostVersion) resourceAttributes.push({ key: 'service.version', value: { stringValue: input.hostVersion } })
  if (input.sessionId) resourceAttributes.push({ key: 'agent_kernel.session_id', value: { stringValue: input.sessionId } })
  if (input.runId) resourceAttributes.push({ key: 'agent_kernel.run_id', value: { stringValue: input.runId } })

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: scopeName, version: scopeVersion },
            spans: input.spans.map(toOtlpSpan),
          },
        ],
      },
    ],
  }
}

function toOtlpSpan(span: EnhancementSpan): OtlpSpan {
  const start = toNano(span.startTime)
  const end = toNano(span.endTime)
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: kindToOtlp(span.kind),
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    status: {
      code: span.status === 'OK' ? 1 : span.status === 'ERROR' ? 2 : 0,
      ...(span.status === 'ERROR' && typeof span.attributes['error.type'] === 'string'
        ? { message: String(span.attributes['error.type']) }
        : {}),
    },
    attributes: toAttributes(span.attributes),
    events: span.events.map((event) => ({
      timeUnixNano: toNano(event.time),
      name: event.name,
      attributes: toAttributes(event.attributes ?? {}),
    })),
  }
}

function kindToOtlp(kind: EnhancementSpan['kind']): number {
  switch (kind) {
    case 'LLM':
    case 'TOOL':
    case 'EVALUATOR':
    case 'RETRIEVER':
    case 'MEMORY':
      return 3
    case 'CHAIN':
    case 'AGENT':
      return 1
    case 'PROMPT':
      return 5
    default:
      return 1
  }
}

function toAttributes(record: Record<string, unknown>): OtlpAttribute[] {
  const out: OtlpAttribute[] = []
  for (const [key, raw] of Object.entries(record)) {
    if (raw === undefined || raw === null) continue
    const value = toAttributeValue(raw)
    if (value) out.push({ key, value })
  }
  return out
}

function toAttributeValue(raw: unknown): OtlpAttribute['value'] | undefined {
  if (typeof raw === 'string') return { stringValue: raw }
  if (typeof raw === 'boolean') return { boolValue: raw }
  if (typeof raw === 'number') {
    if (Number.isInteger(raw)) return { intValue: String(raw) }
    return { doubleValue: raw }
  }
  if (Array.isArray(raw)) {
    const values = raw
      .map((item) => toAttributeValue(item))
      .filter((v): v is OtlpAttribute['value'] => v !== undefined)
    return { arrayValue: { values } }
  }
  try {
    return { stringValue: JSON.stringify(raw) }
  } catch {
    return undefined
  }
}

function toNano(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp)
  if (Number.isNaN(ms)) return '0'
  return (BigInt(ms) * NANO_PER_MS).toString()
}

export type WriteOtlpFileInput = {
  rootDir: string
  filename?: string
  bundle: OtlpTraceBundle
}

export async function writeOtlpFile(input: WriteOtlpFileInput): Promise<string> {
  const dir = join(input.rootDir, 'traces', 'otlp')
  await mkdir(dir, { recursive: true })
  const filename = input.filename ?? `${new Date().toISOString().replace(/[:.]/g, '-')}.otlp.json`
  const path = join(dir, filename)
  await writeFile(path, `${JSON.stringify(input.bundle, null, 2)}\n`, 'utf8')
  return path
}

export type OtlpHttpExporterOptions = {
  endpoint: string
  headers?: Record<string, string>
  retries?: number
  retryDelayMs?: number
  timeoutMs?: number
  onError?: (attempt: number, err: unknown) => void
}

export type OtlpHttpExportResult = {
  status: 'ok' | 'failed'
  attempts: number
  httpStatus?: number
  error?: string
}

export async function postOtlpBundle(
  bundle: OtlpTraceBundle,
  options: OtlpHttpExporterOptions,
): Promise<OtlpHttpExportResult> {
  const retries = options.retries ?? 2
  const retryDelayMs = options.retryDelayMs ?? 500
  const timeoutMs = options.timeoutMs ?? 15_000
  const body = JSON.stringify(bundle)
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.headers ?? {}),
        },
        body,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (response.ok) return { status: 'ok', attempts: attempt, httpStatus: response.status }
      if (response.status >= 500 && attempt <= retries) {
        options.onError?.(attempt, new Error(`otlp export got status ${response.status}`))
        await delay(retryDelayMs * attempt)
        continue
      }
      return { status: 'failed', attempts: attempt, httpStatus: response.status, error: `otlp export got status ${response.status}` }
    } catch (err) {
      clearTimeout(timer)
      options.onError?.(attempt, err)
      if (attempt > retries) {
        return {
          status: 'failed',
          attempts: attempt,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      await delay(retryDelayMs * attempt)
    }
  }
  return { status: 'failed', attempts: retries + 1, error: 'exhausted retries' }
}
