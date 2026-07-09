/**
 * `trace export-otlp` command: reads a session log, generates OpenInference
 * spans, converts them to OTLP/HTTP JSON, and either writes the payload to
 * disk (`--output`) or posts it to a collector endpoint (`--endpoint`, plus
 * optional `--header key=value` pairs and `--retries`).
 *
 * All of the OTLP mechanics live in `otlp-exporter.ts`; this module is the
 * thin operator entrypoint.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { exportSessionSpans } from '@agent-kernel/shared/enhancement'

import {
  postOtlpBundle,
  spansToOtlp,
  writeOtlpFile,
  type OtlpTraceBundle,
} from './otlp-exporter.js'
import { readSessionLog } from './store/log.js'

export type TraceExportOtlpInput = {
  rootDir: string
  sessionLogPath: string
  runId?: string
  evalInstanceId?: string
  endpoint?: string
  headers?: Record<string, string>
  retries?: number
  retryDelayMs?: number
  timeoutMs?: number
  outputFilename?: string
  serviceName?: string
  hostVersion?: string
}

export type TraceExportOtlpResult = {
  sessionId: string
  spanCount: number
  bundlePath?: string
  export?: {
    endpoint: string
    status: 'ok' | 'failed'
    attempts: number
    httpStatus?: number
    error?: string
  }
}

export async function exportTraceOtlp(
  input: TraceExportOtlpInput,
): Promise<TraceExportOtlpResult> {
  const parsed = await readSessionLog(input.sessionLogPath)
  const spans = exportSessionSpans({
    header: parsed.header,
    events: parsed.events,
    runId: input.runId,
    evalInstanceId: input.evalInstanceId,
  })
  const bundle: OtlpTraceBundle = spansToOtlp({
    spans,
    sessionId: parsed.header.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.serviceName ? { serviceName: input.serviceName } : {}),
    ...(input.hostVersion ? { hostVersion: input.hostVersion } : {}),
  })
  const bundlePath = await writeOtlpFile({
    rootDir: input.rootDir,
    filename: input.outputFilename ?? `${basename(input.sessionLogPath, '.jsonl')}.otlp.json`,
    bundle,
  })
  const result: TraceExportOtlpResult = {
    sessionId: parsed.header.sessionId,
    spanCount: spans.length,
    bundlePath,
  }
  if (input.endpoint) {
    const exported = await postOtlpBundle(bundle, {
      endpoint: input.endpoint,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.retries !== undefined ? { retries: input.retries } : {}),
      ...(input.retryDelayMs !== undefined ? { retryDelayMs: input.retryDelayMs } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    })
    result.export = {
      endpoint: input.endpoint,
      status: exported.status,
      attempts: exported.attempts,
      ...(exported.httpStatus !== undefined ? { httpStatus: exported.httpStatus } : {}),
      ...(exported.error ? { error: exported.error } : {}),
    }
  }
  return result
}

/**
 * Parse `--header key=value` occurrences from an argv slice. Returns undefined
 * when none are present so ops-cli can omit the property.
 */
export function parseHeaderArgs(argv: readonly string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg !== '--header') continue
    const next = argv[i + 1]
    if (!next) throw new Error('--header requires a key=value argument')
    const eq = next.indexOf('=')
    if (eq <= 0) throw new Error(`--header value must be key=value, got: ${next}`)
    out[next.slice(0, eq).trim()] = next.slice(eq + 1)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Load headers from a JSON file (dashboard-managed collector secrets) if the
 * caller passes `--headers-file` instead of many `--header` args.
 */
export async function loadHeadersFile(path: string | undefined): Promise<Record<string, string> | undefined> {
  if (!path) return undefined
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error(`headers file: ${key} must be a string`)
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}
