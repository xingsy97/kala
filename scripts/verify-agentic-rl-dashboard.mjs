#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import puppeteer from 'puppeteer-core'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.VERIFY_AGENTIC_RL_DASHBOARD_PORT ?? 3191)
const HOST_URL = `http://localhost:${PORT}`
const CHROME = process.env.CHROME_PATH ?? detectBrowser()
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'ak-agentic-rl-dashboard-e2e-'))
const SESSIONS_DIR = join(TMP_ROOT, 'sessions')
const ARTIFACT_ROOT = join(TMP_ROOT, 'artifacts')
const checks = []
const hostLog = []
let host
let browser

try {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'], { timeoutMs: 30_000 })
  host = spawn('pnpm', ['--filter', '@agent-kernel/host', 'dev'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST_PORT: String(PORT),
      SESSIONS_DIR,
      AGENT_KERNEL_ARTIFACTS_DIR: ARTIFACT_ROOT,
      DASHBOARD_DIR: join(REPO_ROOT, 'packages/dashboard/dist'),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeLog(host, hostLog)
  await waitForLog(hostLog, `127.0.0.1:${PORT}`, 10_000)
  if (!CHROME) throw new Error('no chromium found; set CHROME_PATH')
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(12_000)
  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 })
  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await page.click('[data-testid="app-shell-nav-benchmarks"]')
  await page.waitForSelector('[data-testid="rl-readiness-panel"]')
  await page.waitForSelector('[data-testid="rl-readiness-empty"]')
  let body = await bodyText(page)
  check('missing artifact root does not expose ENOENT in browser', !/ENOENT|scandir|\/home\//.test(body), body.slice(0, 500))

  writeRlReadyArtifact()
  await page.click('[data-testid="rl-readiness-refresh"]')
  await page.waitForSelector('[data-testid="rl-readiness-row-rollout-e2e"]')
  body = await bodyText(page)
  check('dashboard renders slime sample readiness', body.includes('slime-sample-ready') && body.includes('rollout-e2e'), body.slice(0, 700))
  check('dashboard renders token/reward/sample evidence', body.includes('tokens: 1') && body.includes('reward: Yes') && body.includes('sample: Yes'), body.slice(0, 700))
  await page.click('[data-testid="rl-readiness-row-rollout-e2e"] button')
  await page.waitForSelector('[data-testid="rl-readiness-detail"]')
  const detail = await textContent(page, '[data-testid="rl-readiness-detail"]')
  check('dashboard expands rollout artifact detail', detail.includes('rollout-e2e') && detail.includes('task-e2e'), detail)
} catch (err) {
  check('script completed without uncaught error', false, err?.stack ?? String(err))
} finally {
  if (browser) await browser.close().catch(() => {})
  await stopProcess(host)
  if (process.env.KEEP_AGENTIC_RL_DASHBOARD_E2E !== '1') rmSync(TMP_ROOT, { recursive: true, force: true })
  else console.log(`kept e2e directory: ${TMP_ROOT}`)
}

const failed = checks.filter((item) => !item.pass)
if (failed.length > 0) {
  console.error('\n--- host log tail ---')
  console.error(hostLog.join('').slice(-4000))
  process.exit(1)
}

function writeRlReadyArtifact() {
  const dir = join(ARTIFACT_ROOT, 'rl-rollouts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rollout-e2e.json'), JSON.stringify({
    schemaVersion: 'agent.rl.rollout_result.v1',
    rolloutId: 'rollout-e2e',
    taskId: 'task-e2e',
    sessionId: 'session-e2e',
    status: 'completed',
    readiness: 'slime-sample-ready',
    startedAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T00:00:01.000Z',
    durationMs: 1000,
    tokenCaptureRefs: [{ kind: 'rl_token_capture', uri: 'rl-token-captures/rollout-e2e/capture.json', sha256: 'x', bytes: 1, mediaType: 'application/json' }],
    rewardRef: { kind: 'rl_reward', uri: 'rl-rewards/rollout-e2e.json', sha256: 'x', bytes: 1, mediaType: 'application/json' },
    trajectoryRef: { kind: 'rl_trajectory', uri: 'rl-trajectories/rollout-e2e.json', sha256: 'x', bytes: 1, mediaType: 'application/json' },
    sampleValidationRef: { kind: 'rl_sample_validation', uri: 'rl-sample-validations/rollout-e2e.json', sha256: 'x', bytes: 1, mediaType: 'application/json' },
  }, null, 2) + '\n', 'utf8')
}

async function run(command, args, opts = {}) {
  const child = spawn(command, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
  const timeout = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 20_000)
  const code = await new Promise((resolve) => child.on('close', resolve))
  clearTimeout(timeout)
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${out.slice(-2000)}`)
}

function pipeLog(child, target) {
  child?.stdout?.on('data', (chunk) => target.push(String(chunk)))
  child?.stderr?.on('data', (chunk) => target.push(String(chunk)))
}

async function waitForLog(logs, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (logs.join('').includes(needle)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for host log: ${needle}`)
}

async function stopProcess(child) {
  if (!child || child.killed) return
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  await sleep(300)
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
}

async function bodyText(page) {
  return await page.evaluate(() => document.body.textContent ?? '')
}

async function textContent(page, selector) {
  return await page.$eval(selector, (node) => node.textContent ?? '')
}

function check(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  const line = `${pass ? 'PASS' : 'FAIL'} ${name}`
  if (pass) console.log(line)
  else console.error(`${line}: ${detail}`)
}

function detectBrowser() {
  for (const candidate of ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium']) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
