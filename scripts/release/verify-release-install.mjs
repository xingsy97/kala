#!/usr/bin/env node
// Install-time smoke for the pre-built release/ artifacts. Simulates a user who
// downloads the embedded host asset into a clean directory, runs
// `bundle-dashboard-with-runtime.cjs` with only environment configuration (no repo source
// tree and no DASHBOARD_DIR), and checks that the server boots and serves the
// embedded dashboard.
//
// Reads release/manifest.json to know which assets to install; fails if any
// required asset is missing. Never mutates the checked-in `release/` directory.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const releaseDir = join(repoRoot, 'release')
const manifestPath = join(releaseDir, 'manifest.json')

if (!existsSync(manifestPath)) fail('missing release/manifest.json — run build-release-assets first')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!Array.isArray(manifest.assets)) fail('release manifest missing assets array')

const requiredAssets = ['bundle-dashboard-with-runtime.cjs']
for (const asset of requiredAssets) {
  if (!existsSync(join(releaseDir, asset))) fail(`missing required asset: ${asset}`)
}

const installDir = mkdtempSync(join(tmpdir(), 'agent-kernel-install-'))
const sessionsDir = join(installDir, 'sessions')
const artifactsDir = join(installDir, 'artifacts')
mkdirSync(sessionsDir, { recursive: true })
mkdirSync(artifactsDir, { recursive: true })

for (const asset of requiredAssets) {
  copyFileSync(join(releaseDir, asset), join(installDir, asset))
}

const port = await findFreePort()
const hostCjs = join(installDir, 'bundle-dashboard-with-runtime.cjs')

const env = {
  ...process.env,
  HOST_PORT: String(port),
  SESSIONS_DIR: sessionsDir,
  AGENT_KERNEL_ARTIFACTS_DIR: artifactsDir,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'smoke-key-not-used',
  AK_ALLOW_ALL_OK: '0',
}
delete env.HOME_INSTANCE
delete env.HOST_AUTH_TOKEN
delete env.DASHBOARD_DIR

const child = spawn('node', [hostCjs], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

try {
  await waitForServer(port, 15_000)
  const url = `http://127.0.0.1:${port}`
  const manifestRes = await fetch(`${url}/artifacts/manifest`)
  if (!manifestRes.ok) {
    fail(`GET /artifacts/manifest returned ${manifestRes.status}`)
  }
  const manifestBody = await manifestRes.json()
  if (
    manifestBody?.schemaVersion !== 1 ||
    !Array.isArray(manifestBody?.entries) ||
    typeof manifestBody?.summary?.entryCount !== 'number'
  ) {
    fail(`GET /artifacts/manifest returned unexpected shape: ${JSON.stringify(manifestBody).slice(0, 200)}`)
  }
  const dashboardRes = await fetch(`${url}/`, { redirect: 'manual' })
  if (dashboardRes.status !== 200) {
    fail(`GET / returned ${dashboardRes.status}, expected static dashboard`)
  }
  const dashboardHtml = await dashboardRes.text()
  if (!dashboardHtml.includes('<html')) {
    fail(`GET / did not return an HTML dashboard shell (got ${dashboardHtml.slice(0, 200)})`)
  }
  for (const [asset, expectedType] of [
    ['install-executor.sh', 'text/x-shellscript'],
    ['install-executor.ps1', 'text/plain'],
  ]) {
    const assetRes = await fetch(`${url}/install/assets/${asset}`)
    if (assetRes.status !== 200) fail(`GET /install/assets/${asset} returned ${assetRes.status}`)
    if (!assetRes.headers.get('content-type')?.includes(expectedType)) {
      fail(`GET /install/assets/${asset} returned unexpected content-type ${assetRes.headers.get('content-type')}`)
    }
    const actual = await assetRes.text()
    const expected = readFileSync(join(releaseDir, asset), 'utf8')
    if (actual !== expected) fail(`GET /install/assets/${asset} did not return the built release asset`)
  }
  console.log(`release install smoke passed on port ${port} in ${installDir}`)
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`)
  console.error('--- host stdout ---')
  console.error(stdout)
  console.error('--- host stderr ---')
  console.error(stderr)
  process.exitCode = 1
} finally {
  child.kill('SIGTERM')
  const exit = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'timeout' }), 5000)),
  ])
  if (exit && exit.signal === 'timeout') child.kill('SIGKILL')
  rmSync(installDir, { recursive: true, force: true })
}

async function waitForServer(portToProbe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${portToProbe}/models`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // still starting up
    }
    await sleep(150)
  }
  throw new Error(`host did not start on port ${portToProbe} within ${timeoutMs}ms`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (typeof address === 'object' && address && typeof address.port === 'number') {
        const port = address.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('failed to allocate ephemeral port')))
      }
    })
    srv.on('error', reject)
  })
}

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

void basename
