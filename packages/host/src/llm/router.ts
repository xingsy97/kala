/**
 * Multi-provider router. When the CLI is started with several providers, we
 * build one adapter per (provider, model) and pick between them per call.
 * Matching prefers an exact `model` hit; otherwise it falls back to prefix
 * match; otherwise it uses the configured default. Exact-first ordering
 * matters when two entries share a stem (e.g. `gpt-5.5` and `gpt-5.5-mini`).
 */

import type { LLMAdapter, LLMCallParams, LLMResponse } from './adapter.js'

export type RouterOptions = {
  readonly defaultAdapter: LLMAdapter
  readonly byPrefix: ReadonlyArray<{ prefix: string; adapter: LLMAdapter }>
}

export function routerAdapter(opts: RouterOptions): LLMAdapter {
  return {
    name: `router(${[
      opts.defaultAdapter.name,
      ...opts.byPrefix.map((p) => `${p.prefix}=${p.adapter.name}`),
    ].join(',')})`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const target = resolve(opts, params.model)
      return target.call(params)
    },
  }
}

function resolve(opts: RouterOptions, model: string | undefined): LLMAdapter {
  if (!model) return opts.defaultAdapter
  const exact = opts.byPrefix.find((p) => p.prefix === model)
  if (exact) return exact.adapter
  const prefix = opts.byPrefix.find((p) => model.startsWith(p.prefix))
  return prefix?.adapter ?? opts.defaultAdapter
}
