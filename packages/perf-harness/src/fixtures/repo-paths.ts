import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locate repository-relative paths without hard-coding any absolute path or
 * user-specific directory. Everything is derived from this module's own URL so
 * the harness is portable across machines and CI.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** Walk up from this file until we find the repo root (has `pnpm-workspace.yaml`). */
export function repoRoot(): string {
  let dir = HERE
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fallback: this file lives at packages/perf-harness/src/fixtures, so the
  // repo root is four levels up.
  return resolve(HERE, '..', '..', '..', '..')
}

/** Absolute path to the built dashboard bundle (`packages/dashboard/dist`). */
export function dashboardDistDir(): string {
  return join(repoRoot(), 'packages', 'dashboard', 'dist')
}

/** Absolute path to the dashboard entry HTML. */
export function dashboardIndexHtml(): string {
  return join(dashboardDistDir(), 'index.html')
}

/** True when a dashboard bundle has already been built. */
export function isDashboardBuilt(): boolean {
  return existsSync(dashboardIndexHtml())
}

/**
 * Resolve the local Chrome/Chromium executable. Honors PUPPETEER_EXECUTABLE_PATH
 * / CHROME_PATH, then falls back to common install locations. Throws a clear
 * error if none is found so callers get an actionable message.
 */
export function resolveChromeExecutable(): string {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'No Chrome/Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH (or CHROME_PATH) to your browser binary.',
  )
}
