import { replyOnceLlm } from '../fixtures/index.js'
import type { ScenarioContext, ScenarioResult } from './types.js'

export const SAAS_CAPABILITIES_LLM = () => replyOnceLlm('ok')

export async function runSaasCapabilities(ctx: ScenarioContext): Promise<ScenarioResult> {
  const { session, stack } = ctx
  await session.waitForComposer()
  try {
    await session.page.waitForFunction(() => !document.querySelector('[data-testid="app-shell-nav-benchmarks"]'), { timeout: 5_000 })
  } catch (error) {
    const diagnostic = await session.page.evaluate(async () => {
      const host = new URLSearchParams(location.search).get('host') ?? location.origin
      try { return { host, response: await fetch(`${host}/runtime/capabilities`).then(async (r) => ({ status: r.status, text: await r.text() })), nav: document.body.textContent?.slice(0, 300) } }
      catch (fetchError) { return { host, fetchError: String(fetchError), nav: document.body.textContent?.slice(0, 300) } }
    })
    throw new Error(`SaaS capability bootstrap failed: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  const metrics = await session.page.evaluate(async (host) => {
    location.hash = '#/benchmarks'
    await new Promise((resolve) => setTimeout(resolve, 100))
    const capability = await fetch(`${host}/runtime/capabilities`).then((response) => response.json()) as { mode: string; capabilities: { benchmarks: boolean; evaluations: boolean } }
    const direct = await fetch(`${host}/eval/swebench/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    return {
      benchmarkNavVisible: Boolean(document.querySelector('[data-testid="app-shell-nav-benchmarks"]')),
      hash: location.hash,
      mode: capability.mode,
      benchmarks: capability.capabilities.benchmarks,
      evaluations: capability.capabilities.evaluations,
      directStatus: direct.status,
      directBody: await direct.text(),
    }
  }, stack.hostOrigin)
  const pass = !metrics.benchmarkNavVisible && metrics.hash === '#/agent' && metrics.mode === 'saas' && !metrics.benchmarks && !metrics.evaluations && metrics.directStatus === 403 && metrics.directBody.includes('FEATURE_DISABLED')
  return { name: 'saas-capabilities', reproduces: 'SaaS exposes Agent while hiding and blocking Benchmark/Evaluation.', metrics, pass, notes: JSON.stringify(metrics) }
}
