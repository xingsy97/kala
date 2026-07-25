import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CDPSession, Page } from 'puppeteer-core'
import { SourceMapConsumer } from 'source-map'

import { dashboardDistDir } from '../fixtures/repo-paths.js'

/**
 * Record a CDP JS CPU profile while an action runs and attribute self-time to
 * *original* source functions using the dashboard bundle's source maps. This is
 * how a minified hot spot like `Z8` is resolved back to
 * `toolRiskWeight @ human-attention/evaluator.ts` — the single most useful
 * signal for finding a main-thread long task.
 *
 * Requires the dashboard to have been built WITH source maps
 * (`vite build --sourcemap`). Without maps, entries fall back to minified names.
 */

export type SelfTimeEntry = {
  /** Original function name (or the minified name if no map). */
  functionName: string
  /** Original source path (repo-relative-ish) or the bundle file. */
  source: string
  /** 1-based line in the original source, when known. */
  line: number | null
  /** Self time attributed to this frame, in milliseconds. */
  selfMs: number
}

export type CpuProfileResult = {
  /** Total wall time of the profiled window (ms). */
  durationMs: number
  /** Top self-time frames, highest first. Excludes idle/program/GC synthetics. */
  hotSpots: SelfTimeEntry[]
  /** Whether source maps were found and applied. */
  sourceMapped: boolean
}

export type CpuProfileOptions = {
  /** Sampling interval in microseconds (smaller = finer, more overhead). Default 200. */
  samplingIntervalUs?: number
  /** How many top frames to return. Default 20. */
  topN?: number
}

/** Run `action` under a CDP CPU profile and return source-mapped hot spots. */
export async function profileMainThread(
  page: Page,
  cdp: CDPSession,
  action: () => Promise<void>,
  options: CpuProfileOptions = {},
): Promise<CpuProfileResult> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: options.samplingIntervalUs ?? 200 })
  await cdp.send('Profiler.start')

  const started = Date.now()
  await action()
  const durationMs = Date.now() - started

  const { profile } = await cdp.send('Profiler.stop')

  const nodesById = new Map<number, { functionName: string; url: string; lineNumber: number; columnNumber: number }>()
  for (const node of profile.nodes ?? []) nodesById.set(node.id, node.callFrame)

  const selfByKey = new Map<string, { frame: typeof nodesById extends Map<number, infer V> ? V : never; us: number }>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i += 1) {
    const frame = nodesById.get(samples[i]!)
    if (!frame) continue
    const key = `${frame.functionName}|${frame.url}|${frame.lineNumber}|${frame.columnNumber}`
    const existing = selfByKey.get(key)
    const us = Math.max(0, deltas[i] ?? 0)
    if (existing) existing.us += us
    else selfByKey.set(key, { frame, us })
  }

  const consumers = await loadDashboardSourceMaps()
  const sourceMapped = consumers.size > 0

  const SYNTHETIC = new Set(['(idle)', '(program)', '(garbage collector)', '(root)', ''])
  const entries: SelfTimeEntry[] = []
  for (const { frame, us } of selfByKey.values()) {
    if (SYNTHETIC.has(frame.functionName) && !frame.url) continue
    const bundleFile = frame.url.split('/').pop() ?? ''
    const consumer = consumers.get(bundleFile)
    if (consumer) {
      // CDP line/column are 0-based; source-map expects 1-based line.
      const orig = consumer.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber })
      entries.push({
        functionName: orig.name ?? frame.functionName ?? '(anonymous)',
        source: orig.source ? orig.source.split('/').slice(-2).join('/') : bundleFile,
        line: orig.line ?? null,
        selfMs: Math.round((us / 1000) * 10) / 10,
      })
    } else {
      entries.push({
        functionName: frame.functionName || '(anonymous)',
        source: bundleFile || frame.url || '(native)',
        line: frame.lineNumber >= 0 ? frame.lineNumber + 1 : null,
        selfMs: Math.round((us / 1000) * 10) / 10,
      })
    }
  }
  for (const consumer of consumers.values()) consumer.destroy()

  entries.sort((a, b) => b.selfMs - a.selfMs)
  return { durationMs, hotSpots: entries.slice(0, options.topN ?? 20), sourceMapped }
}

/** Load every `*.js.map` in the dashboard dist, keyed by the bundle file name. */
async function loadDashboardSourceMaps(): Promise<Map<string, SourceMapConsumer>> {
  const dist = join(dashboardDistDir(), 'assets')
  const consumers = new Map<string, SourceMapConsumer>()
  let files: string[]
  try {
    const { readdirSync } = await import('node:fs')
    files = readdirSync(dist).filter((f) => f.endsWith('.js.map'))
  } catch {
    return consumers
  }
  for (const mapFile of files) {
    const bundleFile = mapFile.replace(/\.map$/, '')
    try {
      const raw = JSON.parse(readFileSync(join(dist, mapFile), 'utf8'))
      consumers.set(bundleFile, await new SourceMapConsumer(raw))
    } catch {
      // Skip unreadable/invalid maps.
    }
  }
  return consumers
}
