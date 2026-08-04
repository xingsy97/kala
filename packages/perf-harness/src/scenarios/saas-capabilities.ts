import { replyOnceLlm } from '../fixtures/index.js'
import type { ScenarioContext, ScenarioResult } from './types.js'

export const SAAS_CAPABILITIES_LLM = () => replyOnceLlm('ok')

export async function runSaasCapabilities(ctx: ScenarioContext): Promise<ScenarioResult> {
  const { session, stack } = ctx
  await session.waitForComposer()
  try {
    await session.page.waitForFunction(() => Boolean(document.querySelector('[data-testid="app-shell-nav-agent"]')), { timeout: 5_000 })
  } catch (error) {
    const diagnostic = await session.page.evaluate(async () => {
      const host = new URLSearchParams(location.search).get('host') ?? location.origin
      try { return { host, response: await fetch(`${host}/runtime/capabilities`).then(async (r) => ({ status: r.status, text: await r.text() })), nav: document.body.textContent?.slice(0, 300) } }
      catch (fetchError) { return { host, fetchError: String(fetchError), nav: document.body.textContent?.slice(0, 300) } }
    })
    throw new Error(`SaaS capability bootstrap failed: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  const metrics = await session.page.evaluate(async (host) => {
    const capability = await fetch(`${host}/runtime/capabilities`).then((response) => response.json()) as { mode: string; capabilities: { agent: boolean; workspace: boolean } }
    const direct = await fetch(`${host}/eval/swebench/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    return {
      mode: capability.mode,
      agent: capability.capabilities.agent,
      workspace: capability.capabilities.workspace,
      directStatus: direct.status,
      directBody: await direct.text(),
    }
  }, stack.hostOrigin)
  const pass = metrics.mode === 'saas' && metrics.agent && metrics.workspace && metrics.directStatus === 404
  return { name: 'saas-capabilities', reproduces: 'SaaS publishes only product capabilities and has no legacy evaluation route.', metrics, pass, notes: JSON.stringify(metrics) }
}
