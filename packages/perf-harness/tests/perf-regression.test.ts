import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

/**
 * Performance regression tests.
 *
 * The heavy browser scenarios are driven through the package's own CLI
 * (`bin/run-scenario.ts`, run via tsx) rather than imported directly: that path
 * already resolves the workspace packages (host/executor/shared, including their
 * export subpaths) exactly like a normal run, whereas importing the host into
 * vitest would require aliasing every internal subpath. The CLI exits non-zero
 * when a scenario misses its threshold, which is what we assert.
 *
 * These are environment-sensitive (they need a built dashboard bundle and a
 * local Chrome), so they self-skip when those aren't available rather than
 * failing spuriously. Thresholds are structural/relative, not absolute-ms.
 *
 * Run explicitly:  pnpm --filter @agent-kernel/perf-harness perf
 */

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const tsxBin = resolve(pkgRoot, 'node_modules', '.bin', 'tsx')
const cli = resolve(pkgRoot, 'bin', 'run-scenario.ts')
const dashboardIndex = resolve(pkgRoot, '..', 'dashboard', 'dist', 'index.html')

function chromeAvailable(): boolean {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_PATH
  if (fromEnv && existsSync(fromEnv)) return true
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(existsSync)
}

function environmentReady(): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(tsxBin)) return { ok: false, reason: 'tsx not installed in perf-harness' }
  if (!existsSync(dashboardIndex)) return { ok: false, reason: 'dashboard bundle not built (pnpm --filter @agent-kernel/dashboard build)' }
  if (!chromeAvailable()) return { ok: false, reason: 'no Chrome/Chromium found (set PUPPETEER_EXECUTABLE_PATH)' }
  return { ok: true }
}

const env = environmentReady()
const runIf = env.ok ? it : it.skip
const SCENARIO_TIMEOUT_MS = 120_000

async function runScenario(name: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(tsxBin, [cli, name], { cwd: pkgRoot, timeout: SCENARIO_TIMEOUT_MS - 5_000 })
    return { code: 0, stdout }
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '' }
  }
}

describe('perf-harness regressions', () => {
  if (!env.ok) {
    it.skip(`skipped: ${env.reason}`, () => { /* environment not ready */ })
  }

  it('CLI lists the known scenarios', async () => {
    const tsx = existsSync(tsxBin) ? tsxBin : null
    if (!tsx) return // covered by the skip above
    const { stdout } = await execFileAsync(tsx, [cli], { cwd: pkgRoot })
    for (const name of ['streaming-scroll-anchor', 'streaming-scroll-anchor-mobile', 'streaming-markdown-flicker', 'status-indicator-jank', 'inspector-open-cost', 'mobile-inspector-overflow']) {
      expect(stdout).toContain(name)
    }
  })

  runIf(
    'streaming keeps the historical viewport anchored after user scroll-up',
    async () => {
      const { code, stdout } = await runScenario('streaming-scroll-anchor')
      expect(stdout).toContain('PASS')
      expect(code).toBe(0)
    },
    SCENARIO_TIMEOUT_MS,
  )

  runIf(
    'streaming markdown keeps already-rendered blocks stable',
    async () => {
      const { code, stdout } = await runScenario('streaming-markdown-flicker')
      expect(stdout).toContain('PASS')
      expect(code).toBe(0)
    },
    SCENARIO_TIMEOUT_MS,
  )

  runIf(
    'status indicator does not re-mount on every tool step',
    async () => {
      const { code, stdout } = await runScenario('status-indicator-jank')
      expect(stdout).toContain('PASS')
      expect(code).toBe(0)
    },
    SCENARIO_TIMEOUT_MS,
  )
})
