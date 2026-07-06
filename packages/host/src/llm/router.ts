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

export type MutableRouter = LLMAdapter & {
  addRoute(prefix: string, adapter: LLMAdapter): void
  deleteRoute(prefix: string): void
}

export function routerAdapter(opts: RouterOptions): MutableRouter {
  const byPrefix = [...opts.byPrefix]
  return {
    name: `router(${[
      opts.defaultAdapter.name,
      ...byPrefix.map((p) => `${p.prefix}=${p.adapter.name}`),
    ].join(',')})`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const target = resolve({ defaultAdapter: opts.defaultAdapter, byPrefix }, params.model)
      return target.call(params)
    },
    addRoute(prefix, adapter) {
      const existing = byPrefix.findIndex((p) => p.prefix === prefix)
      if (existing === -1) byPrefix.push({ prefix, adapter })
      else byPrefix[existing] = { prefix, adapter }
    },
    deleteRoute(prefix) {
      const index = byPrefix.findIndex((p) => p.prefix === prefix)
      if (index !== -1) byPrefix.splice(index, 1)
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
