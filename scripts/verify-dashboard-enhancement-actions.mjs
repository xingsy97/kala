#!/usr/bin/env node
/**
 * Real dashboard E2E for enhancement artifact actions.
 *
 * This starts the production dashboard bundle behind a real host process and
 * drives it through Chromium. It verifies both UI behavior and the files
 * produced by the host action endpoints; no fetch mocks or component harnesses
 * are involved.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import puppeteer from 'puppeteer-core'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.VERIFY_DASHBOARD_ENHANCEMENT_PORT ?? 3183)
const HOST_URL = `http://localhost:${PORT}`
const CHROME = process.env.CHROME_PATH ?? detectBrowser()
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'ak-dashboard-enhancement-e2e-'))
const SESSIONS_DIR = join(TMP_ROOT, 'sessions')
const ARTIFACT_ROOT = join(TMP_ROOT, 'artifacts')
const FIXTURE_ROOT = join(TMP_ROOT, 'fixtures')
const RUN_ID = 'dashboard-e2e'

const checks = []
const hostLog = []
let host
let browser

try {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  mkdirSync(ARTIFACT_ROOT, { recursive: true })
  const fixture = writeSweBenchFixture()

  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'], {
    name: 'dashboard build',
    timeoutMs: 30_000,
  })

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
  await waitForLog(hostLog, `"port":${PORT}`, 10_000)

  if (!CHROME) throw new Error('no chromium found; set CHROME_PATH')
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(12_000)
  await page.setViewport({ width: 1440, height: 940, deviceScaleFactor: 1 })

  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isExpectedConsoleError(msg.text())) pageErrors.push(msg.text())
  })

  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await page.waitForSelector('[data-testid="eval-dashboard-button"]')
  await page.click('[data-testid="eval-dashboard-button"]')
  await page.waitForSelector('[data-testid="swebench-plan-panel"]')

  await verifyPlanFailure(page, fixture)
  await verifyPlanSuccess(page, fixture)
  await verifyInferSuccess(page, fixture)
  await verifyGradeCommand(page)

  const manifest = await fetchJson(`${HOST_URL}/artifacts/manifest`)
  const paths = manifest.entries.map((entry) => entry.path)
  check('artifact manifest includes dashboard-created SWE-bench files', paths.includes(`${RUN_ID}/worker-plan.json`) && paths.includes(`${RUN_ID}/predictions.jsonl`) && paths.includes(`${RUN_ID}/summary.json`), paths.filter((path) => path.startsWith(`${RUN_ID}/`)).join(', '))
  check('no browser console or page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (err) {
  check('script completed without uncaught error', false, err?.stack ?? String(err))
} finally {
  if (browser) await browser.close().catch(() => {})
  await stopProcess(host)
  if (process.env.KEEP_DASHBOARD_ENHANCEMENT_E2E !== '1') rmSync(TMP_ROOT, { recursive: true, force: true })
  else console.log(`kept e2e directory: ${TMP_ROOT}`)
}

const failed = checks.filter((check) => !check.pass)
if (failed.length > 0) {
  console.error('\n--- host log tail ---')
  console.error(hostLog.join('').slice(-4000))
  process.exit(1)
}

async function verifyPlanFailure(page, fixture) {
  await page.click('[data-testid="swebench-plan-toggle"]')
  await replaceValue(page, '[data-testid="swebench-plan-run-id"]', `${RUN_ID}-bad`)
  await replaceValue(page, '[data-testid="swebench-plan-model"]', 'dashboard-e2e-model')
  await replaceValue(page, '[data-testid="swebench-plan-instances-jsonl"]', join(fixture.root, 'missing.jsonl'))
  await replaceValue(page, '[data-testid="swebench-plan-root-dir"]', ARTIFACT_ROOT)
  await page.click('[data-testid="swebench-plan-submit"]')
  await page.waitForSelector('[data-testid="swebench-plan-error"]')
  const text = await textContent(page, '[data-testid="swebench-plan-error"]')
  check('SWE-bench plan failure is surfaced in the real dialog', /ENOENT|no such file|missing/i.test(text), text)
}

async function verifyPlanSuccess(page, fixture) {
  await replaceValue(page, '[data-testid="swebench-plan-run-id"]', RUN_ID)
  await replaceValue(page, '[data-testid="swebench-plan-model"]', 'dashboard-e2e-model')
  await replaceValue(page, '[data-testid="swebench-plan-instances-jsonl"]', fixture.instances)
  await replaceValue(page, '[data-testid="swebench-plan-root-dir"]', ARTIFACT_ROOT)
  await replaceValue(page, '[data-testid="swebench-plan-instance-ids"]', 'local__repo-1, local__repo-2')
  await replaceValue(page, '[data-testid="swebench-plan-limit"]', '2')
  await replaceValue(page, '[data-testid="swebench-plan-max-workers"]', '2')
  await page.click('[data-testid="swebench-plan-submit"]')
  await page.waitForSelector('[data-testid="swebench-plan-result"]')
  const text = await textContent(page, '[data-testid="swebench-plan-result"]')
  const planPath = join(ARTIFACT_ROOT, RUN_ID, 'worker-plan.json')
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  check('SWE-bench plan succeeds through browser and host', text.includes('2 instances') && plan.selectedCount === 2 && plan.shards.length === 2, `${text} / ${planPath}`)
}

async function verifyInferSuccess(page, fixture) {
  await page.click('[data-testid="enhancement-action-toggle"]')
  await page.select('[data-testid="enhancement-action-select"]', 'swebench-infer-patches')
  await replaceValue(page, '[data-testid="enhancement-action-root-dir"]', ARTIFACT_ROOT)
  await replaceValue(page, '[data-testid="enhancement-action-field-runId"]', RUN_ID)
  await replaceValue(page, '[data-testid="enhancement-action-field-dataset"]', 'local/SWE-bench-e2e')
  await replaceValue(page, '[data-testid="enhancement-action-field-model"]', 'dashboard-e2e-model')
  await replaceValue(page, '[data-testid="enhancement-action-field-instancesJsonl"]', fixture.instances)
  await replaceValue(page, '[data-testid="enhancement-action-field-patchesDir"]', fixture.patches)
  await replaceValue(page, '[data-testid="enhancement-action-field-instanceIds"]', 'local__repo-1, local__repo-2')
  await replaceValue(page, '[data-testid="enhancement-action-field-limit"]', '2')
  await page.click('[data-testid="enhancement-action-submit"]')
  await page.waitForSelector('[data-testid="enhancement-action-result"]')
  const text = await textContent(page, '[data-testid="enhancement-action-result"]')
  const predictionsPath = join(ARTIFACT_ROOT, RUN_ID, 'predictions.jsonl')
  const rows = readFileSync(predictionsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  check('SWE-bench infer action creates official prediction JSONL through dashboard', text.includes('predictions.jsonl') && rows.length === 2 && rows.every((row) => row.instance_id && typeof row.model_patch === 'string'), `${text} / rows=${rows.length}`)
}

async function verifyGradeCommand(page) {
  await page.select('[data-testid="enhancement-action-select"]', 'swebench-grade-command')
  await replaceValue(page, '[data-testid="enhancement-action-field-runId"]', RUN_ID)
  await replaceValue(page, '[data-testid="enhancement-action-field-dataset"]', 'local/SWE-bench-e2e')
  await replaceValue(page, '[data-testid="enhancement-action-field-predictionsPath"]', join(ARTIFACT_ROOT, RUN_ID, 'predictions.jsonl'))
  await replaceValue(page, '[data-testid="enhancement-action-field-maxWorkers"]', '2')
  await replaceValue(page, '[data-testid="enhancement-action-field-instanceIds"]', 'local__repo-1')
  await page.click('[data-testid="enhancement-action-submit"]')
  await page.waitForSelector('[data-testid="enhancement-action-result"]')
  const text = await textContent(page, '[data-testid="enhancement-action-result"]')
  check('SWE-bench grade command is generated through dashboard without running Docker', text.includes('python -m swebench.harness.run_evaluation') && text.includes('--predictions_path'), text)
}

function writeSweBenchFixture() {
  const patches = join(FIXTURE_ROOT, 'patches')
  mkdirSync(patches, { recursive: true })
  const instances = join(FIXTURE_ROOT, 'instances.jsonl')
  writeFileSync(
    instances,
    [
      { instance_id: 'local__repo-1', repo: 'local/repo', problem_statement: 'fix one' },
      { instance_id: 'local__repo-2', repo: 'local/repo', problem_statement: 'fix two' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  )
  writeFileSync(join(patches, 'local__repo-1.diff'), 'diff --git a/a.txt b/a.txt\n+fixed\n', 'utf8')
  writeFileSync(join(patches, 'local__repo-2.diff'), 'diff --git a/b.txt b/b.txt\n+fixed\n', 'utf8')
  return { root: FIXTURE_ROOT, instances, patches }
}

async function replaceValue(page, selector, value) {
  await page.waitForSelector(selector)
  await page.$eval(selector, (el) => { el.value = '' })
  await page.click(selector)
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control')
  await page.keyboard.press('A')
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control')
  await page.keyboard.press('Backspace')
  await page.type(selector, value)
}

async function textContent(page, selector) {
  return page.$eval(selector, (el) => el.textContent ?? '')
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`)
  return res.json()
}

function check(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}

function isExpectedConsoleError(text) {
  return text.includes('Failed to load resource: the server responded with a status of 400')
}

function detectBrowser() {
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ]
  for (const path of candidates) if (existsSync(path)) return path
  return undefined
}

function pipeLog(proc, log) {
  proc.stdout.on('data', (b) => log.push(b.toString()))
  proc.stderr.on('data', (b) => log.push(b.toString()))
}

async function waitForLog(log, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (log.join('').includes(needle)) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for log: ${needle}`)
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    proc.kill('SIGTERM')
  }
  const deadline = Date.now() + 2_000
  while (proc.exitCode === null && Date.now() < deadline) await sleep(50)
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}

async function run(cmd, args, opts) {
  const proc = spawn(cmd, args, { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  pipeLog(proc, log)
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${opts.name} timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)
    proc.on('exit', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })
  if (code !== 0) throw new Error(`${opts.name} failed with ${code}\n${log.join('')}`)
  check(opts.name, true)
}
