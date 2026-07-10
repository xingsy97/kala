import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EnhancementSpan } from '@agent-kernel/shared/enhancement'
import { describe, expect, it, vi } from 'vitest'

import { postOtlpBundle, spansToOtlp, writeOtlpFile } from './otlp-exporter.js'

function span(overrides: Partial<EnhancementSpan> = {}): EnhancementSpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'agent.invoke',
    kind: 'AGENT',
    startTime: '2026-07-09T10:00:00.000Z',
    endTime: '2026-07-09T10:00:01.000Z',
    status: 'OK',
    attributes: {
      'openinference.span.kind': 'AGENT',
      'gen_ai.usage.input_tokens': 42,
      'gen_ai.usage.output_tokens': 17,
    },
    events: [{ name: 'agent_kernel.trace_captured', time: '2026-07-09T10:00:00.500Z' }],
    ...overrides,
  }
}

describe('spansToOtlp', () => {
  it('encodes attributes with the correct typed value shapes', () => {
    const bundle = spansToOtlp({
      spans: [span()],
      serviceName: 'agent-kernel-test',
      sessionId: 'session-A',
      runId: 'run-1',
    })
    const scopeSpans = bundle.resourceSpans[0]!.scopeSpans[0]!
    expect(scopeSpans.spans).toHaveLength(1)
    const attrs = scopeSpans.spans[0]!.attributes
    const input = attrs.find((a) => a.key === 'gen_ai.usage.input_tokens')!
    expect(input.value).toEqual({ intValue: '42' })
    const kind = attrs.find((a) => a.key === 'openinference.span.kind')!
    expect(kind.value).toEqual({ stringValue: 'AGENT' })
    const resource = bundle.resourceSpans[0]!.resource.attributes
    expect(resource.find((a) => a.key === 'agent_kernel.session_id')?.value).toEqual({ stringValue: 'session-A' })
    expect(resource.find((a) => a.key === 'agent_kernel.run_id')?.value).toEqual({ stringValue: 'run-1' })
  })

  it('encodes error status codes', () => {
    const bundle = spansToOtlp({ spans: [span({ status: 'ERROR', attributes: { 'error.type': 'tool_error' } })] })
    expect(bundle.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status.code).toBe(2)
  })

  it('emits nanosecond timestamps', () => {
    const bundle = spansToOtlp({ spans: [span()] })
    const first = bundle.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    expect(first.startTimeUnixNano).toMatch(/[0-9]+/)
    expect(first.endTimeUnixNano).not.toBe('0')
    expect(BigInt(first.endTimeUnixNano) - BigInt(first.startTimeUnixNano)).toBe(1_000_000_000n)
  })
})

describe('writeOtlpFile', () => {
  it('writes the OTLP bundle to traces/otlp/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otlp-'))
    try {
      const bundle = spansToOtlp({ spans: [span()] })
      const path = await writeOtlpFile({ rootDir: dir, filename: 'test.otlp.json', bundle })
      expect(path.endsWith('/traces/otlp/test.otlp.json')).toBe(true)
      const raw = JSON.parse(await readFile(path, 'utf8')) as { resourceSpans: unknown[] }
      expect(raw.resourceSpans).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('postOtlpBundle', () => {
  it('reports success when the collector returns 2xx', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock
    try {
      const bundle = spansToOtlp({ spans: [span()] })
      const result = await postOtlpBundle(bundle, {
        endpoint: 'http://collector.local/v1/traces',
        retries: 0,
      })
      expect(result.status).toBe('ok')
      expect(result.attempts).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries on 5xx up to the configured limit', async () => {
    let count = 0
    const fetchMock = vi.fn(async () => {
      count++
      return count < 2 ? new Response(null, { status: 503 }) : new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock
    try {
      const bundle = spansToOtlp({ spans: [span()] })
      const result = await postOtlpBundle(bundle, {
        endpoint: 'http://collector.local/v1/traces',
        retries: 3,
        retryDelayMs: 1,
      })
      expect(result.status).toBe('ok')
      expect(result.attempts).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns failure after exhausting retries', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock
    try {
      const bundle = spansToOtlp({ spans: [span()] })
      const result = await postOtlpBundle(bundle, {
        endpoint: 'http://collector.local/v1/traces',
        retries: 1,
        retryDelayMs: 1,
      })
      expect(result.status).toBe('failed')
      expect(result.attempts).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
