import type { AnyBenchmarkAdapter, BenchmarkKind } from '../core/benchmark-adapter.js'
import { swebenchAdapter } from '../swebench/swebench-adapter.js'
import { terminalBenchAdapter } from '../terminal-bench/terminal-bench-adapter.js'

const ADAPTERS: Readonly<Record<BenchmarkKind, AnyBenchmarkAdapter>> = {
  'swe-bench': swebenchAdapter as unknown as AnyBenchmarkAdapter,
  'terminal-bench': terminalBenchAdapter as unknown as AnyBenchmarkAdapter,
}

export function getAdapter(kind: BenchmarkKind): AnyBenchmarkAdapter {
  const adapter = ADAPTERS[kind]
  if (!adapter) throw new Error(`unknown benchmark kind: ${kind}`)
  return adapter
}

export function listAdapters(): readonly BenchmarkKind[] {
  return Object.keys(ADAPTERS) as BenchmarkKind[]
}
