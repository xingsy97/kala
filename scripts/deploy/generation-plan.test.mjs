import { mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { activateGeneration, waitForOriginBarrier, waitForRestartPhase } from './deploy-finalize.mjs'
import { createGenerationPlan, launchFinalizeScript, prepareGenerationScript, systemdDropInScript, transactionJson, verifyGenerationScript } from './generation-plan.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function plan() {
  return createGenerationPlan({
    remoteBin: '/opt/runlab', service: 'agent-runlab-host', hostUrl: 'http://127.0.0.1:13000',
    files: ['SHA256SUMS', 'bundle-dashboard-with-runtime.cjs'], bundleHash: 'a'.repeat(64),
    sessionId: 'session-origin', callId: 'call-origin', deployId: 'deploy-1',
  })
}

describe('transactional generation deployment', () => {
  it('builds one immutable generation and an external finalize handoff', () => {
    const value = plan()
    expect(value.generationDir).toBe('/opt/runlab/deploy/releases/deploy-1')
    expect(prepareGenerationScript(value)).toContain('deploy.active')
    expect(prepareGenerationScript(value)).toContain('bootstrap-required')
    expect(verifyGenerationScript(value)).toContain('sha256sum -c SHA256SUMS')
    expect(systemdDropInScript(value)).toContain('/opt/runlab/deploy/current/bundle-dashboard-with-runtime.cjs')
    expect(launchFinalizeScript(value)).toContain('systemd-run')
    expect(launchFinalizeScript(value)).not.toContain('systemctl restart')
    expect(JSON.parse(transactionJson(value))).toMatchObject({ sessionId: 'session-origin', callId: 'call-origin', phase: 'staged' })
  })

  it('atomically switches current to a verified generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'generation-'))
    roots.push(root)
    const oldDir = join(root, 'old')
    const nextDir = join(root, 'next')
    const current = join(root, 'current')
    mkdirSync(oldDir); mkdirSync(nextDir)
    activateGeneration({ currentLink: current, generationDir: oldDir })
    activateGeneration({ currentLink: current, generationDir: nextDir })
    expect(readlinkSync(current)).toBe(nextDir)
  })

  it('waits for the origin Tool result instead of using a fixed delay', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ persisted: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ persisted: true }) })
    await waitForOriginBarrier({ hostUrl: 'http://host', sessionId: 's', callId: 'c', timeoutMs: 1000, pollMs: 1, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('matches only the exact restart attempt and tolerates the replacement outage', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ current: { attemptId: 'other', phase: 'checkpoint_reached' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ current: { attemptId: 'wanted', phase: 'checkpoint_reached' }, pid: 2 }) })
    const result = await waitForRestartPhase({ hostUrl: 'http://host', attemptId: 'wanted', phase: 'checkpoint_reached', timeoutMs: 1000, pollMs: 1, fetchImpl })
    expect(result.status.pid).toBe(2)
  })
})
