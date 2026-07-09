#!/usr/bin/env node
/**
 * Real dashboard E2E for enhancement artifact actions.
 *
 * This starts the production dashboard bundle behind a real host process and
 * drives it through Chromium. It covers the dashboard equivalent of every
 * enhancement action with real HTTP calls and real artifact files. Heavy
 * external systems stay out of this CI-safe test: Docker SWE-bench grading is
 * verified as a generated official command, not executed.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
const RELIABILITY_LOG_DIR = join(FIXTURE_ROOT, 'reliability-logs')
const WORKSPACE_ROOT = join(TMP_ROOT, 'workspace')
const RUN_ID = 'dashboard-e2e'
const EXPORT_RUN_ID = 'dashboard-export-e2e'
const COMPARE_ROOT = join(ARTIFACT_ROOT, 'compare')
const PROFILE_ROOT = join(ARTIFACT_ROOT, 'profile')
const MEMORY_ROOT = join(ARTIFACT_ROOT, 'memory')
const OPS_ROOT = join(ARTIFACT_ROOT, 'ops')

const checks = []
const hostLog = []
let host
let browser
let page
let actionPrefix = 'enhancement-action-eval-artifact-actions'

try {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  const fixture = writeFixtures()

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
  page = await browser.newPage()
  page.setDefaultTimeout(12_000)
  await page.setViewport({ width: 1440, height: 940, deviceScaleFactor: 1 })

  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isExpectedConsoleError(msg.text())) pageErrors.push(msg.text())
  })

  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await verifyMissingArtifactRootFirstUse()
  await openArtifactMode('eval')
  await verifySweBenchPlanFailure(fixture)
  await verifySweBenchPlanSuccess(fixture)
  await verifyEvalActions(fixture)
  await verifySweBenchActions(fixture)
  await verifyProfileActions(fixture)
  await verifyMemoryActions(fixture)
  await verifyOpsActions(fixture)
  await verifyManifestAndViews()
  await verifyInstancesSourceTabs()
  await verifyRunBenchmarkWizard(fixture)
  await verifyDiscoverability()
  await verifyNewParityActions(fixture)

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
  console.error(hostLog.join('').slice(-5000))
  process.exit(1)
}

async function verifySweBenchPlanFailure(fixture) {
  await page.click('[data-testid="swebench-plan-toggle"]')
  await replaceValue('[data-testid="swebench-plan-run-id"]', `${RUN_ID}-bad`)
  await replaceValue('[data-testid="swebench-plan-model"]', 'dashboard-e2e-model')
  await replaceValue('[data-testid="swebench-plan-instances-jsonl"]', join(fixture.root, 'missing.jsonl'))
  await replaceValue('[data-testid="swebench-plan-root-dir"]', ARTIFACT_ROOT)
  await page.click('[data-testid="swebench-plan-submit"]')
  await page.waitForSelector('[data-testid="swebench-plan-error"]')
  const text = await textContent('[data-testid="swebench-plan-error"]')
  check('SWE-bench plan failure is surfaced in the real dialog', /ENOENT|no such file|missing/i.test(text), text)
}

async function verifyMissingArtifactRootFirstUse() {
  check('e2e starts with a missing artifact root', !existsSync(ARTIFACT_ROOT), ARTIFACT_ROOT)
  for (const mode of ['eval', 'ops', 'profiles']) {
    await openArtifactMode(mode)
    await page.waitForFunction(
      () => !(document.body.textContent ?? '').includes('ENOENT: no such file or directory'),
      { timeout: 5_000 },
    )
    const text = await bodyText()
    check(`artifact ${mode} view tolerates missing artifact root`, !/ENOENT|scandir/.test(text), text.slice(0, 400))
  }
  const manifest = await page.evaluate(async () => {
    const res = await fetch('/artifacts/manifest', { cache: 'no-store' })
    return { status: res.status, body: await res.json() }
  })
  check('missing artifact root manifest request returns an empty manifest', manifest.status === 200 && manifest.body?.summary?.entryCount === 0, JSON.stringify(manifest))
  check('missing artifact root is initialized for later writes', existsSync(ARTIFACT_ROOT), ARTIFACT_ROOT)
}

async function verifySweBenchPlanSuccess(fixture) {
  await replaceValue('[data-testid="swebench-plan-run-id"]', RUN_ID)
  await replaceValue('[data-testid="swebench-plan-model"]', 'dashboard-e2e-model')
  await replaceValue('[data-testid="swebench-plan-instances-jsonl"]', fixture.instances)
  await replaceValue('[data-testid="swebench-plan-root-dir"]', ARTIFACT_ROOT)
  await replaceValue('[data-testid="swebench-plan-instance-ids"]', 'local__repo-1, local__repo-2')
  await replaceValue('[data-testid="swebench-plan-limit"]', '2')
  await replaceValue('[data-testid="swebench-plan-max-workers"]', '2')
  await page.click('[data-testid="swebench-plan-submit"]')
  await page.waitForSelector('[data-testid="swebench-plan-result"]')
  const text = await textContent('[data-testid="swebench-plan-result"]')
  const plan = readJsonFile(join(ARTIFACT_ROOT, RUN_ID, 'worker-plan.json'))
  check('SWE-bench plan succeeds through browser and host', text.includes('2 instances') && plan.selectedCount === 2 && plan.shards.length === 2, text)
}

async function verifyEvalActions(fixture) {
  await openActionPanel('eval')
  await runAction('eval-judge-score', {
    fields: {
      promptPath: fixture.judgePrompt,
      responsePath: fixture.judgeResponse,
      judgeModel: 'judge-e2e-model',
      scorer: 'dashboard_e2e_judge',
      instanceId: 'local__repo-1',
      threshold: '0.7',
      inputRef: 'local__repo-1',
    },
    expectText: 'scores.json',
  })
  const judgeScore = readJsonFile(join(ARTIFACT_ROOT, 'scores.json'))
  check('eval judge score action writes parseable score artifact', judgeScore.resolved === true && judgeScore.results[0]?.scorer === 'dashboard_e2e_judge', JSON.stringify(judgeScore))

  await runAction('eval-score-session', {
    fields: {
      sessionLogPath: fixture.sessionLog,
      instanceId: 'local__repo-1',
      patchPath: fixture.patchFile,
      requireDone: 'true',
    },
    expectText: 'scores.json',
  })
  const sessionScore = readJsonFile(join(ARTIFACT_ROOT, 'scores.json'))
  check('eval score session action evaluates real session log and patch', sessionScore.resolved === true && sessionScore.results.some((row) => row.scorer === 'patch.non_empty'), JSON.stringify(sessionScore))

  await runAction('eval-compare-runs', {
    fields: {
      baselineSummaryPath: fixture.baselineSummary,
      candidateSummaryPath: fixture.candidateSummary,
    },
    expectText: 'eval-comparison.json',
  })
  const comparison = readJsonFile(join(ARTIFACT_ROOT, 'eval-comparison.json'))
  check('eval compare runs action writes pass-rate delta', comparison.deltas.passRate === 0.5, JSON.stringify(comparison.deltas))
}

async function verifySweBenchActions(fixture) {
  await runAction('swebench-infer-patches', {
    fields: {
      runId: RUN_ID,
      dataset: 'local/SWE-bench-e2e',
      model: 'dashboard-e2e-model',
      instancesJsonl: fixture.instances,
      patchesDir: fixture.patches,
      instanceIds: 'local__repo-1, local__repo-2',
      limit: '2',
    },
    expectText: 'predictions.jsonl',
  })
  const predictions = readJsonlFile(join(ARTIFACT_ROOT, RUN_ID, 'predictions.jsonl'))
  check('SWE-bench infer action creates official prediction JSONL through dashboard', predictions.length === 2 && predictions.every((row) => row.instance_id && typeof row.model_patch === 'string'), `rows=${predictions.length}`)

  await runAction('swebench-export-session', {
    fields: {
      runId: EXPORT_RUN_ID,
      dataset: 'local/SWE-bench-e2e',
      model: 'dashboard-e2e-model',
      instanceId: 'local__repo-1',
      sessionLogPath: fixture.sessionLog,
      modelPatchPath: fixture.patchFile,
    },
    expectText: 'predictions.jsonl',
  })
  const exported = readJsonlFile(join(ARTIFACT_ROOT, EXPORT_RUN_ID, 'predictions.jsonl'))
  check('SWE-bench export session action writes prediction from a real session log', exported.length === 1 && exported[0].instance_id === 'local__repo-1', JSON.stringify(exported[0]))

  await runAction('swebench-ingest-results', {
    fields: { runId: RUN_ID, resultsDir: fixture.resultsDir },
    expectText: 'summary.json',
  })
  const summary = readJsonFile(join(ARTIFACT_ROOT, RUN_ID, 'summary.json'))
  check('SWE-bench ingest results action updates summary from official-shaped result rows', summary.resolved === 1 && summary.failed === 1, JSON.stringify(summary))

  await runAction('swebench-grade-command', {
    fields: {
      runId: RUN_ID,
      dataset: 'local/SWE-bench-e2e',
      predictionsPath: join(ARTIFACT_ROOT, RUN_ID, 'predictions.jsonl'),
      maxWorkers: '2',
      instanceIds: 'local__repo-1',
    },
    expectText: 'python -m swebench.harness.run_evaluation',
  })
  const gradeText = await textContent(`[data-testid="${actionPrefix}-result"]`)
  check('SWE-bench grade command is generated through dashboard without running Docker', gradeText.includes('--predictions_path') && gradeText.includes('--instance_ids'), gradeText)
}

async function verifyProfileActions(fixture) {
  await runApiAction('profile-session', {
    rootDir: PROFILE_ROOT,
    fields: { sessionLogPath: fixture.sessionLog, pricingPath: fixture.pricingPath },
  })
  const profile = readJsonFile(join(PROFILE_ROOT, 'profile.json'))
  check('profile session action writes latency/token/cost profile from session log', profile.sessionId === 'e2e-parent' && profile.llmCalls >= 1 && profile.costStatus === 'estimated', JSON.stringify(profile))
}

async function verifyMemoryActions(fixture) {
  await runApiAction('memory-index', {
    rootDir: MEMORY_ROOT,
    fields: { workspaceRoot: WORKSPACE_ROOT },
  })
  const index = readJsonFile(join(MEMORY_ROOT, 'memory-index.json'))
  check('memory index action writes active and tombstoned workspace memory entries', index.entries.some((row) => row.key === 'project-style' && row.status === 'active') && index.entries.some((row) => row.key === 'old-note' && row.status === 'tombstoned'), JSON.stringify(index.entries))
}

async function verifyOpsActions(fixture) {
  await runApiAction('reliability-audit-session', {
    rootDir: OPS_ROOT,
    fields: { sessionLogPath: fixture.danglingLog },
  })
  const audit = readJsonFile(join(OPS_ROOT, 'reliability-audit.json'))
  check('reliability audit action detects dangling tool calls', audit.dangling === true && audit.danglingKind === 'tool_call', JSON.stringify(audit))

  await runApiAction('reliability-chaos-replay', {
    rootDir: OPS_ROOT,
    fields: { sessionLogPaths: `${fixture.danglingLog}, ${fixture.recoveredLog}` },
  })
  const chaos = readJsonFile(join(OPS_ROOT, 'reliability-chaos.json'))
  check('reliability chaos replay action summarizes dangling and recovered sessions', chaos.sessionCount === 2 && chaos.danglingCount === 1 && chaos.recoveryEventCount === 1, JSON.stringify(chaos))

  await runApiAction('trace-export-session', {
    rootDir: OPS_ROOT,
    fields: { sessionLogPath: fixture.sessionLog, runId: RUN_ID, evalInstanceId: 'local__repo-1', workspaceRoot: WORKSPACE_ROOT },
  })
  const trace = readJsonFile(join(OPS_ROOT, 'traces', 'e2e-parent.openinference.json'))
  check('trace export action writes OpenInference-shaped spans and provider request artifacts', Array.isArray(trace.spans) && trace.spans.length >= 1 && existsSync(join(OPS_ROOT, 'llm', 'e2e-parent', '2.request.json')), `spans=${trace.spans?.length}`)

  await runApiAction('rollout-export-segments', {
    rootDir: OPS_ROOT,
    fields: { sessionLogPath: fixture.sessionLog, runId: RUN_ID, evalInstanceId: 'local__repo-1', workspaceRoot: WORKSPACE_ROOT },
  })
  const segments = readJsonFile(join(OPS_ROOT, 'rl-token-segments', 'e2e-parent.json'))
  check('rollout segment action captures topology without token-id synthesis', segments.tokenIdsCaptured === false && segments.topology.subAgentCallCount === 1 && segments.segments.length >= 4, JSON.stringify(segments.topology))

  await runApiAction('rollout-export-session', {
    rootDir: OPS_ROOT,
    fields: {
      sessionLogPath: fixture.sessionLog,
      taskId: 'swebench:local__repo-1',
      frameworkTarget: 'slime',
      model: 'dashboard-e2e-model',
      weightVersion: 'e2e-weight',
    },
  })
  const sidecarPath = latestJsonFile(join(OPS_ROOT, 'rollouts'))
  const sidecar = readJsonFile(sidecarPath)
  check('rollout sidecar action writes trace-linked RL metadata', sidecar.framework_target === 'slime' && sidecar.trace_ref && sidecar.token_segments_ref, JSON.stringify(sidecar))

  await runApiAction('rollout-export-adapter', {
    rootDir: OPS_ROOT,
    fields: { sidecarPath, frameworkTarget: 'slime' },
  })
  const adapter = readJsonFile(join(OPS_ROOT, 'rl-adapters', 'slime', basename(sidecarPath)))
  check('rollout adapter action writes framework-specific adapter manifest', adapter.status === 'ready' && adapter.frameworkTarget === 'slime' && adapter.entrypoint === 'custom_rollout_manifest', JSON.stringify(adapter))

  await runApiAction('subagents-graph', {
    rootDir: OPS_ROOT,
    fields: { sessionsDir: SESSIONS_DIR },
  })
  const graph = readJsonFile(join(OPS_ROOT, 'subagent-graph.json'))
  check('subagent graph action exports parent-child session topology', graph.nodes.length >= 2 && graph.edges.some((edge) => edge.parentSessionId === 'e2e-parent' && edge.childSessionId === 'e2e-child'), JSON.stringify(graph))
}

async function verifyManifestAndViews() {
  const manifest = await fetchJson(`${HOST_URL}/artifacts/manifest`)
  const paths = manifest.entries.map((entry) => entry.path)
  const required = [
    `${RUN_ID}/worker-plan.json`,
    `${RUN_ID}/predictions.jsonl`,
    `${RUN_ID}/summary.json`,
    `${EXPORT_RUN_ID}/predictions.jsonl`,
    'eval-comparison.json',
    'profile/profile.json',
    'memory/memory-index.json',
    'ops/reliability-audit.json',
    'ops/reliability-chaos.json',
    'ops/traces/e2e-parent.openinference.json',
    'ops/rl-token-segments/e2e-parent.json',
    'ops/subagent-graph.json',
  ]
  const missing = required.filter((path) => !paths.includes(path))
  check('artifact manifest includes every dashboard-created enhancement artifact family', missing.length === 0, missing.join(', '))

  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await openArtifactMode('eval')
  const evalText = await bodyText()
  check('Eval artifact view renders generated runs, scores, comparisons, and worker plans', evalText.includes(RUN_ID) && evalText.includes('Scores') && evalText.includes('Comparisons') && evalText.includes('Worker plans'), evalText.slice(0, 500))
  await openArtifactMode('profiles')
  check('Profile artifact view renders generated profile', (await bodyText()).includes('e2e-parent'))
  await openArtifactMode('memory')
  check('Memory artifact view renders generated memory index', (await bodyText()).includes('project-style'))
  await openArtifactMode('ops')
  await page.waitForFunction(
    () => (document.body.textContent ?? '').includes('reliability-audit.json') && (document.body.textContent ?? '').includes('subagent-graph.json'),
    { timeout: 12_000 },
  )
  const opsText = await bodyText()
  check('Ops artifact view renders generated reliability, trace, rollout, and subagent artifacts', opsText.includes('reliability-audit.json') && opsText.includes('rl-token-segments') && opsText.includes('subagent-graph.json'), opsText.slice(0, 700))
}

async function verifyInstancesSourceTabs() {
  const PASTE_RUN_ID = 'wizard-paste-e2e'
  const UPLOAD_RUN_ID = 'wizard-upload-e2e'
  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await openArtifactMode('eval')
  await waitForVisible('[data-testid="run-benchmark-wizard-toggle"]')
  const toggleText = await visibleText('[data-testid="run-benchmark-wizard-toggle"]')
  if (!toggleText.includes('hide')) await clickVisible('[data-testid="run-benchmark-wizard-toggle"]')

  await replaceValue('[data-testid="run-benchmark-wizard-run-id"]', PASTE_RUN_ID)
  const pasteContent = [
    JSON.stringify({ instance_id: 'paste__row-1', repo: 'org/paste' }),
    JSON.stringify({ instance_id: 'paste__row-2', repo: 'org/paste' }),
  ].join('\n') + '\n'
  const pasteSummary = await resolveInstancesViaPaste(pasteContent)
  check(
    'wizard paste tab resolves inline JSONL and reports the count without leaking server paths',
    pasteSummary.includes('2 instances') && !pasteSummary.includes(ARTIFACT_ROOT),
    pasteSummary.slice(0, 240),
  )
  const pasteResolved = readFileSync(join(ARTIFACT_ROOT, PASTE_RUN_ID, 'instances.jsonl'), 'utf8')
  check('wizard paste tab writes canonical JSONL under the artifact root', pasteResolved.trim().split('\n').length === 2, pasteResolved.slice(0, 240))

  await replaceValue('[data-testid="run-benchmark-wizard-run-id"]', UPLOAD_RUN_ID)
  const uploadPath = join(FIXTURE_ROOT, 'wizard-upload.jsonl')
  writeFileSync(uploadPath, [
    JSON.stringify({ instance_id: 'upload__row-1', repo: 'org/upload' }),
    JSON.stringify({ instance_id: 'upload__row-2', repo: 'org/upload' }),
    JSON.stringify({ instance_id: 'upload__row-3', repo: 'org/upload' }),
  ].join('\n') + '\n', 'utf8')
  const uploadSummary = await resolveInstancesViaUpload(uploadPath)
  check(
    'wizard upload tab resolves a local .jsonl file and reports the count without leaking server paths',
    uploadSummary.includes('3 instances') && !uploadSummary.includes(ARTIFACT_ROOT),
    uploadSummary.slice(0, 240),
  )
  const uploadResolved = readFileSync(join(ARTIFACT_ROOT, UPLOAD_RUN_ID, 'instances.jsonl'), 'utf8')
  check('wizard upload tab writes canonical JSONL under the artifact root', uploadResolved.trim().split('\n').length === 3, uploadResolved.slice(0, 240))
}

async function verifyRunBenchmarkWizard(fixture) {
  const WIZARD_RUN_ID = 'wizard-e2e'
  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await openArtifactMode('eval')
  await waitForVisible('[data-testid="run-benchmark-wizard-toggle"]')
  const toggleText = await visibleText('[data-testid="run-benchmark-wizard-toggle"]')
  if (!toggleText.includes('hide')) await clickVisible('[data-testid="run-benchmark-wizard-toggle"]')
  await waitForVisible('[data-testid="run-benchmark-wizard-plan"]')

  await replaceValue('[data-testid="run-benchmark-wizard-run-id"]', WIZARD_RUN_ID)
  await replaceValue('[data-testid="run-benchmark-wizard-model"]', 'dashboard-e2e-model')
  await replaceValue('[data-testid="run-benchmark-wizard-dataset"]', 'local/SWE-bench-e2e')
  await resolveInstancesViaPaste(readFileSync(fixture.instances, 'utf8'))
  await replaceValue('[data-testid="run-benchmark-wizard-max-workers"]', '2')
  await clickVisible('[data-testid="run-benchmark-wizard-plan-submit"]')
  await page.waitForFunction(
    () => document.querySelector('[data-testid="run-benchmark-wizard-step-plan"]')?.getAttribute('data-status') === 'done',
    { timeout: 12_000 },
  )
  const planFile = readJsonFile(join(ARTIFACT_ROOT, WIZARD_RUN_ID, 'worker-plan.json'))
  check('wizard Plan step creates a worker plan through the browser', planFile.runId === WIZARD_RUN_ID && planFile.model === 'dashboard-e2e-model' && planFile.selectedCount === 2, JSON.stringify({ runId: planFile.runId, model: planFile.model, count: planFile.selectedCount }))

  await waitForVisible('[data-testid="run-benchmark-wizard-infer"]')
  const patchesPayload = JSON.stringify({
    'local__repo-1': readFileSync(join(fixture.patches, 'local__repo-1.diff'), 'utf8'),
    'local__repo-2': readFileSync(join(fixture.patches, 'local__repo-2.diff'), 'utf8'),
  })
  await page.$eval('[data-testid="run-benchmark-wizard-infer-advanced"]', (el) => el.setAttribute('open', 'open'))
  const patchesSummary = await resolvePatchesViaPaste(patchesPayload)
  check('wizard Infer advanced upload accepts patches through the browser without leaking server paths', patchesSummary.includes('2') && !patchesSummary.includes(ARTIFACT_ROOT) && !patchesSummary.includes(FIXTURE_ROOT), patchesSummary.slice(0, 240))
  await clickVisible('[data-testid="run-benchmark-wizard-infer-upload-submit"]')
  await page.waitForFunction(
    () => document.querySelector('[data-testid="run-benchmark-wizard-step-infer"]')?.getAttribute('data-status') === 'done',
    { timeout: 12_000 },
  )
  const wizardPredictions = readJsonlFile(join(ARTIFACT_ROOT, WIZARD_RUN_ID, 'predictions.jsonl'))
  check('wizard Infer step writes official prediction JSONL through the browser', wizardPredictions.length === 2 && wizardPredictions.every((row) => typeof row.model_patch === 'string' && row.instance_id && row.model_name_or_path === 'dashboard-e2e-model'), `rows=${wizardPredictions.length}`)

  await waitForVisible('[data-testid="run-benchmark-wizard-grade"]')
  await clickVisible('[data-testid="run-benchmark-wizard-grade-submit"]')
  await waitForVisible('[data-testid="run-benchmark-wizard-grade-command"]')
  const commandText = await textContent('[data-testid="run-benchmark-wizard-grade-command"]')
  check('wizard Grade step generates official grading shell command without executing Docker', commandText.includes('python -m swebench.harness.run_evaluation') && commandText.includes('--predictions_path') && commandText.includes(WIZARD_RUN_ID), commandText.slice(0, 400))
  await page.waitForFunction(
    () => document.querySelector('[data-testid="run-benchmark-wizard-step-grade"]')?.getAttribute('data-status') === 'done',
    { timeout: 12_000 },
  )

  await clickVisible('[data-testid="run-benchmark-wizard-step-ingest"]')
  await waitForVisible('[data-testid="run-benchmark-wizard-ingest"]')
  const resultsPayload = JSON.stringify({
    'instance_results.jsonl': readFileSync(join(fixture.resultsDir, 'instance_results.jsonl'), 'utf8'),
    'local__repo-2.log': readFileSync(join(fixture.resultsDir, 'local__repo-2.log'), 'utf8'),
  })
  const resultsSummary = await resolveResultsViaPaste(resultsPayload)
  check('wizard Ingest step uploads grade results through the browser without leaking server paths', resultsSummary.includes('2') && !resultsSummary.includes(ARTIFACT_ROOT) && !resultsSummary.includes(FIXTURE_ROOT), resultsSummary.slice(0, 240))
  await clickVisible('[data-testid="run-benchmark-wizard-ingest-submit"]')
  await page.waitForFunction(
    () => document.querySelector('[data-testid="run-benchmark-wizard-step-ingest"]')?.getAttribute('data-status') === 'done',
    { timeout: 12_000 },
  )
  const wizardSummary = readJsonFile(join(ARTIFACT_ROOT, WIZARD_RUN_ID, 'summary.json'))
  check('wizard Ingest step writes summary that matches fixture result rows', wizardSummary.resolved === 1 && wizardSummary.failed === 1 && wizardSummary.trialCount === 2, JSON.stringify({ trialCount: wizardSummary.trialCount, resolved: wizardSummary.resolved, failed: wizardSummary.failed }))

  await waitForVisible('[data-testid="run-benchmark-wizard-review"]')
  const reviewText = await textContent('[data-testid="run-benchmark-wizard-review"]')
  check('wizard Review step surfaces the run id without leaking any server paths', reviewText.includes(WIZARD_RUN_ID) && !reviewText.includes(ARTIFACT_ROOT) && !reviewText.includes(FIXTURE_ROOT) && !reviewText.includes('/home/'), reviewText.slice(0, 400))
  const wizardContainerText = await textContent('[data-testid="run-benchmark-wizard-review"]')
  check('wizard container never leaks absolute /home/ paths', !wizardContainerText.includes('/home/') && !wizardContainerText.includes('worker-plan.json') && !wizardContainerText.includes('run-index.json'), wizardContainerText.slice(0, 400))
}

async function verifyDiscoverability() {
  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await openArtifactMode('eval')
  await waitForVisible('[data-testid="run-benchmark-wizard-toggle"]')
  const toggleLabel = await visibleText('[data-testid="run-benchmark-wizard-toggle"]')
  check('Eval mode surfaces the Run Benchmark wizard as the primary discovery path', /run benchmark/i.test(toggleLabel), toggleLabel)

  if (!toggleLabel.includes('hide')) await clickVisible('[data-testid="run-benchmark-wizard-toggle"]')
  await clickVisible('[data-testid="instances-source-tab-paste"]')
  await waitForVisible('[data-testid="run-benchmark-wizard-instances-help"]')
  await page.$eval('[data-testid="run-benchmark-wizard-instances-help"]', (el) => el.setAttribute('open', 'open'))
  const helpText = await visibleText('[data-testid="run-benchmark-wizard-instances-help"]')
  check(
    'Instances JSONL format is documented inline for a first-time user',
    helpText.includes('instance_id') && helpText.includes('One JSON object per line'),
    helpText.slice(0, 400),
  )

  await openArtifactMode('ops')
  await openActionPanel('ops')
  const opsOptions = await page.$$eval(
    `[data-testid="${actionPrefix}-select"] option`,
    (options) => options.map((option) => option.value),
  )
  const newActions = ['artifacts-manifest', 'artifacts-prune', 'trace-export-otlp', 'rollout-verify-reward']
  const missing = newActions.filter((action) => !opsOptions.includes(action))
  check('Ops action panel exposes CLI-parity actions (manifest/prune/otlp/verify-reward)', missing.length === 0, missing.join(', '))
}

async function verifyNewParityActions(fixture) {
  const PARITY_ROOT = join(ARTIFACT_ROOT, 'parity')
  const OTLP_ROOT = join(PARITY_ROOT, 'otlp')
  const MANIFEST_ROOT = join(PARITY_ROOT, 'manifest')
  const PRUNE_ROOT = join(PARITY_ROOT, 'prune')
  const VERIFY_ROOT = join(PARITY_ROOT, 'reward')

  const otlp = await runApiAction('trace-export-otlp', {
    rootDir: OTLP_ROOT,
    fields: {
      sessionLogPath: fixture.sessionLog,
      runId: 'parity-run',
      evalInstanceId: 'local__repo-1',
      serviceName: 'agent-kernel-e2e',
    },
  })
  check('trace-export-otlp writes a bundle file even without an endpoint', typeof otlp.bundlePath === 'string' && otlp.spanCount >= 1 && !otlp.export, JSON.stringify({ spanCount: otlp.spanCount, hasExport: Boolean(otlp.export) }))
  const bundle = readJsonFile(otlp.bundlePath)
  check('trace-export-otlp bundle contains OTLP resource spans', Array.isArray(bundle.resourceSpans) && bundle.resourceSpans.length >= 1, JSON.stringify({ resourceSpans: bundle.resourceSpans?.length }))

  await runApiAction('artifacts-manifest', { rootDir: MANIFEST_ROOT, fields: {} })
  const manifest = readJsonFile(join(MANIFEST_ROOT, 'artifact-manifest.json'))
  check('artifacts-manifest handles an empty artifact root', manifest.summary.entryCount === 0 && manifest.summary.totalBytes === 0, JSON.stringify(manifest.summary))

  mkdirSync(PRUNE_ROOT, { recursive: true })
  const pruneSample = join(PRUNE_ROOT, 'sample.log')
  writeFileSync(pruneSample, 'noise'.repeat(64), 'utf8')
  const prune = await runApiAction('artifacts-prune', {
    rootDir: PRUNE_ROOT,
    fields: { olderThanDays: '0', dryRun: true },
  })
  check('artifacts-prune dry-run reports removal count without mutating disk', prune.dryRun === true && prune.removedCount >= 1 && existsSync(pruneSample), JSON.stringify({ dryRun: prune.dryRun, removed: prune.removedCount, exists: existsSync(pruneSample) }))

  const trial = { trialId: 'local__repo-1-parity', instanceId: 'local__repo-1', resolved: true, status: 'completed', failureLabel: 'resolved' }
  const trialPath = join(FIXTURE_ROOT, 'graded-trial.json')
  writeFileSync(trialPath, JSON.stringify(trial), 'utf8')
  const reward = await runApiAction('rollout-verify-reward', {
    rootDir: VERIFY_ROOT,
    fields: { trialPath, taskId: 'swebench:local__repo-1' },
  })
  check('rollout-verify-reward maps resolved trial to canonical reward=1.0', reward.reward === 1 && reward.resolved === true && reward.taskId === 'swebench:local__repo-1', JSON.stringify({ reward: reward.reward, resolved: reward.resolved, task: reward.taskId }))
}

async function openArtifactMode(mode) {
  const button = mode === 'eval'
    ? '[data-testid="eval-dashboard-button"]'
    : mode === 'ops'
      ? '[data-testid="ops-artifacts-button"]'
      : '[data-testid="artifacts-button"]'
  const modeButton = `[data-testid="artifact-mode-${mode}"]`
  if (!await visible(modeButton)) {
    await waitForVisible(button)
    await clickVisible(button)
    await waitForVisible('[data-testid="artifact-dialog"]')
  }
  await waitForVisible(modeButton)
  await clickVisible(modeButton)
  await sleep(150)
}

async function resolveInstancesViaPaste(content) {
  await clickVisible('[data-testid="instances-source-tab-paste"]')
  await waitForVisible('[data-testid="instances-paste-textarea"]')
  await replaceValue('[data-testid="instances-paste-textarea"]', content)
  await clickVisible('[data-testid="instances-resolve-button"]')
  await waitForVisible('[data-testid="instances-resolve-summary"]', 15_000)
  return textContent('[data-testid="instances-resolve-summary"]')
}

async function resolveInstancesViaUpload(filePath) {
  await clickVisible('[data-testid="instances-source-tab-upload"]')
  const input = await page.waitForSelector('[data-testid="instances-upload-file"]', { visible: true, timeout: 12_000 })
  await input.uploadFile(filePath)
  await waitForVisible('[data-testid="instances-upload-filename"]', 12_000)
  await clickVisible('[data-testid="instances-resolve-button"]')
  await waitForVisible('[data-testid="instances-resolve-summary"]', 15_000)
  return textContent('[data-testid="instances-resolve-summary"]')
}

async function resolvePatchesViaPaste(pastePayload) {
  await clickVisible('[data-testid="patches-source-tab-paste"]')
  await waitForVisible('[data-testid="patches-paste-textarea"]')
  await replaceValue('[data-testid="patches-paste-textarea"]', pastePayload)
  await clickVisible('[data-testid="patches-resolve-button"]')
  await waitForVisible('[data-testid="patches-resolve-summary"]', 15_000)
  return textContent('[data-testid="patches-resolve-summary"]')
}

async function resolveResultsViaPaste(pastePayload) {
  await clickVisible('[data-testid="results-source-tab-paste"]')
  await waitForVisible('[data-testid="results-paste-textarea"]')
  await replaceValue('[data-testid="results-paste-textarea"]', pastePayload)
  await clickVisible('[data-testid="results-resolve-button"]')
  await waitForVisible('[data-testid="results-resolve-summary"]', 15_000)
  return textContent('[data-testid="results-resolve-summary"]')
}

async function openActionPanel(kind) {
  actionPrefix = `enhancement-action-${kind}-artifact-actions`
  const selector = `[data-testid="${actionPrefix}-toggle"]`
  await waitForVisible(selector)
  const isOpen = await visibleText(selector).then((text) => text.includes('hide'))
  if (!isOpen) await clickVisible(selector)
}

async function runAction(action, opts) {
  const selectSelector = `[data-testid="${actionPrefix}-select"]`
  await waitForVisible(selectSelector)
  await selectVisible(selectSelector, action)
  await page.waitForFunction(
    (selector, selected) => Array.from(document.querySelectorAll(selector)).some((el) => {
      const style = window.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0 && el.value === selected
    }),
    { timeout: 5_000 },
    selectSelector,
    action,
  )
  await sleep(200)
  for (const [key, value] of Object.entries(opts.fields ?? {})) {
    const textSelector = `[data-testid="${actionPrefix}-field-${key}"]`
    const uploadTextareaSelector = `[data-testid="${actionPrefix}-upload-${key}-textarea"]`
    const textExists = await page.$(textSelector)
    if (textExists) {
      await replaceValue(textSelector, String(value))
    } else {
      const uploadExists = await page.$(uploadTextareaSelector)
      if (!uploadExists) throw new Error(`no text or upload input for field ${key} on action ${action}`)
      const content = existsSync(String(value)) ? readFileSync(String(value), 'utf8') : String(value)
      await replaceValue(uploadTextareaSelector, content)
    }
  }
  if (process.env.DEBUG_ACTION) {
    const snapshot = await page.evaluate((prefix) => {
      const fields = {}
      document.querySelectorAll(`[data-testid^="${prefix}-field-"]`).forEach((el) => {
        const key = el.getAttribute('data-testid').replace(`${prefix}-field-`, '')
        fields[key] = el.value
      })
      const uploads = {}
      document.querySelectorAll(`[data-testid^="${prefix}-upload-"][data-testid$="-textarea"]`).forEach((el) => {
        const testId = el.getAttribute('data-testid')
        const key = testId.replace(`${prefix}-upload-`, '').replace(/-textarea$/, '')
        uploads[key] = String(el.value).slice(0, 60)
      })
      return { fields, uploads }
    }, actionPrefix)
    console.log(`DEBUG ${action} snapshot: ${JSON.stringify(snapshot)}`)
  }
  await submitVisibleForm(`[data-testid="${actionPrefix}-form"]`)
  try {
    await page.waitForFunction(
      (selector, expected) => Array.from(document.querySelectorAll(selector)).some((el) => {
        const style = window.getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden' && el.textContent?.includes(expected)
      }),
      { timeout: 12_000 },
      `[data-testid="${actionPrefix}-result"]`,
      opts.expectText,
    )
  } catch (err) {
    const diag = await page.evaluate(() => ({
      result: Array.from(document.querySelectorAll('[data-testid$="-result"]')).map((el) => el.textContent).filter(Boolean).slice(-5),
      error: Array.from(document.querySelectorAll('[data-testid$="-error"]')).map((el) => el.textContent).filter(Boolean).slice(-5),
      action: Array.from(document.querySelectorAll('[data-testid$="-select"]')).map((el) => el.value).filter(Boolean).slice(-5),
      body: document.body.textContent?.slice(0, 1200) ?? '',
    }))
    throw new Error(`action ${action} did not produce expected text ${opts.expectText}: ${JSON.stringify(diag)}`, { cause: err })
  }
}

async function runApiAction(action, opts) {
  const payload = { action, ...(opts.rootDir ? { rootDir: opts.rootDir } : {}), ...(opts.fields ?? {}) }
  const result = await page.evaluate(async (body) => {
    const res = await fetch('/enhancement/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(JSON.stringify(json))
    return json
  }, payload)
  check(`browser API action ${action} returns success`, result?.action === action, JSON.stringify(result).slice(0, 300))
  return result
}

function writeFixtures() {
  mkdirSync(FIXTURE_ROOT, { recursive: true })
  mkdirSync(RELIABILITY_LOG_DIR, { recursive: true })
  mkdirSync(WORKSPACE_ROOT, { recursive: true })
  const swebench = writeSweBenchFixture()
  const sessionLog = writeSessionFixture({ sessionId: 'e2e-parent' })
  const childLog = writeSessionFixture({ sessionId: 'e2e-child', parentSessionId: 'e2e-parent', parentCursor: 2 })
  const danglingLog = writeDanglingSessionFixture('e2e-dangling')
  const recoveredLog = writeRecoveredSessionFixture('e2e-recovered')
  const patchFile = join(FIXTURE_ROOT, 'model.patch')
  writeFileSync(patchFile, 'diff --git a/a.txt b/a.txt\n+fixed from session\n', 'utf8')
  const judgePrompt = join(FIXTURE_ROOT, 'judge-prompt.txt')
  const judgeResponse = join(FIXTURE_ROOT, 'judge-response.json')
  writeFileSync(judgePrompt, 'Score whether the patch resolves local__repo-1.', 'utf8')
  writeFileSync(judgeResponse, JSON.stringify({ score: 0.92, label: 'resolved', explanation: 'Patch is adequate.' }), 'utf8')
  const pricingPath = join(FIXTURE_ROOT, 'pricing.json')
  writeFileSync(pricingPath, JSON.stringify({ version: 'e2e', currency: 'USD', models: { 'dashboard-e2e-model': { inputPerMillion: 2, outputPerMillion: 8 } } }, null, 2), 'utf8')
  const baselineSummary = writeEvalSummary('baseline', 0, join(FIXTURE_ROOT, 'baseline-summary.json'))
  const candidateSummary = writeEvalSummary('candidate', 1, join(FIXTURE_ROOT, 'candidate-summary.json'))
  writeMemoryFixture()
  void childLog
  return { ...swebench, sessionLog, danglingLog, recoveredLog, patchFile, judgePrompt, judgeResponse, pricingPath, baselineSummary, candidateSummary }
}

function writeSweBenchFixture() {
  const patches = join(FIXTURE_ROOT, 'patches')
  const resultsDir = join(FIXTURE_ROOT, 'official-results')
  mkdirSync(patches, { recursive: true })
  mkdirSync(resultsDir, { recursive: true })
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
  writeFileSync(join(resultsDir, 'instance_results.jsonl'), JSON.stringify({ instance_id: 'local__repo-1', resolved: true }) + '\n' + JSON.stringify({ instance_id: 'local__repo-2', resolved: false, error: 'tests failed' }) + '\n', 'utf8')
  writeFileSync(join(resultsDir, 'local__repo-2.log'), 'failing test output', 'utf8')
  return { root: FIXTURE_ROOT, instances, patches, resultsDir }
}

function writeMemoryFixture() {
  const dir = join(WORKSPACE_ROOT, '.agent-kernel', 'memory')
  const tombstones = join(dir, '.tombstones')
  mkdirSync(tombstones, { recursive: true })
  writeFileSync(join(dir, 'project-style.md'), ['---', 'name: Project Style', 'description: Prefer focused tests', 'confidence: 0.8', '---', 'Use real e2e coverage for dashboard features.', ''].join('\n'), 'utf8')
  writeFileSync(join(tombstones, 'old-note.json'), JSON.stringify({ key: 'old-note', deletedAt: new Date().toISOString(), archivedPath: join(dir, 'old-note.md') }, null, 2), 'utf8')
}

function writeEvalSummary(experimentId, resolved, path) {
  const summary = {
    experimentId,
    dataset: 'local/SWE-bench-e2e',
    model: 'dashboard-e2e-model',
    trialCount: 2,
    completed: 2,
    failed: 2 - resolved,
    timedOut: 0,
    resolved,
    unresolved: 2 - resolved,
    emptyPatch: 0,
    failureCounts: resolved === 0 ? { test_failed: 2 } : { test_failed: 1, resolved: 1 },
    metrics: { passRate: resolved / 2 },
  }
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return path
}

function writeSessionFixture({ sessionId, parentSessionId, parentCursor }) {
  const logPath = join(SESSIONS_DIR, `${Date.now()}_${sessionId}.jsonl`)
  const header = headerEntry(sessionId, { parentSessionId, parentCursor })
  const entries = [
    header,
    eventEntry(1, { kind: 'user_message', text: 'fix local__repo-1' }, [{ kind: 'call_llm', messages: [], tools: header.config.tools }]),
    eventEntry(
      2,
      { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'agent-1', name: 'agent', input: { prompt: 'inspect failing test', agent_type: 'research' } }] }, usage: { inputTokens: 120, outputTokens: 30 } },
      [{ kind: 'call_tool', callId: 'agent-1', name: 'agent', input: { prompt: 'inspect failing test', agent_type: 'research' } }],
      {
        provider: 'openai',
        model: 'dashboard-e2e-model',
        request: { url: 'https://redacted.example/v1/chat/completions', headers: { authorization: '[redacted]' }, body: { model: 'dashboard-e2e-model', messages: [{ role: 'user', content: 'fix local__repo-1' }] } },
        response: { status: 200, body: { choices: [{ message: { content: null, tool_calls: [] } }] }, metrics: { durationMs: 75, timeToFirstChunkMs: 20 } },
      },
      'dashboard-e2e-model',
    ),
    eventEntry(3, { kind: 'tool_result', callId: 'agent-1', ok: true, content: '<sub_agent session_id="e2e-child" agent_type="research" status="completed" turns="2" duration_ms="42">done</sub_agent>' }, [{ kind: 'call_llm', messages: [], tools: header.config.tools }]),
    eventEntry(4, { kind: 'compact_replaced', trigger: 'manual', preserveFrom: 2, summary: 'compressed previous context', replacedCount: 2, tokensBefore: 1000, tokensAfter: 120 }, []),
    eventEntry(5, { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'fixed' }] }, usage: { inputTokens: 80, outputTokens: 12 } }, [{ kind: 'finish' }], undefined, 'dashboard-e2e-model'),
  ]
  writeFileSync(logPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  return logPath
}

function writeDanglingSessionFixture(sessionId) {
  const logPath = join(RELIABILITY_LOG_DIR, `${Date.now()}_${sessionId}.jsonl`)
  const header = headerEntry(sessionId)
  const entries = [
    header,
    eventEntry(1, { kind: 'user_message', text: 'read x' }, []),
    eventEntry(2, { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'dangling-1', name: 'read', input: { path: 'x' } }] } }, [{ kind: 'call_tool', callId: 'dangling-1', name: 'read', input: { path: 'x' } }]),
  ]
  writeFileSync(logPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  return logPath
}

function writeRecoveredSessionFixture(sessionId) {
  const logPath = join(RELIABILITY_LOG_DIR, `${Date.now()}_${sessionId}.jsonl`)
  const header = headerEntry(sessionId)
  const entries = [
    header,
    eventEntry(1, { kind: 'user_message', text: 'read x' }, []),
    eventEntry(2, { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'recover-1', name: 'read', input: { path: 'x' } }] } }, [{ kind: 'call_tool', callId: 'recover-1', name: 'read', input: { path: 'x' } }]),
    eventEntry(3, { kind: 'tool_result', callId: 'recover-1', ok: false, content: 'host restarted while call was pending' }, [{ kind: 'call_llm', messages: [], tools: header.config.tools }]),
    eventEntry(4, { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }] } }, [{ kind: 'finish' }]),
  ]
  writeFileSync(logPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  return logPath
}

function headerEntry(sessionId, opts = {}) {
  const config = {
    tools: [
      { name: 'read', description: 'read', inputSchema: { type: 'object' }, requiresApproval: false },
      { name: 'agent', description: 'spawn agent', inputSchema: { type: 'object' }, requiresApproval: false },
    ],
    systemPrompt: 'e2e system',
  }
  return {
    kind: 'header',
    seq: 0,
    ts: new Date().toISOString(),
    sessionId,
    formatVersion: 1,
    kernelVersion: '@agent-kernel/kernel@0.0.0',
    config,
    initialState: {
      sessionId,
      messages: [{ role: 'system', content: [{ type: 'text', text: 'e2e system' }] }],
      pendingCalls: [],
      status: 'idle',
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      cursor: 0,
      cwd: WORKSPACE_ROOT,
      contextPressureLevel: 'none',
      approvalMode: 'auto',
    },
    workspaceId: 'dashboard-enhancement-e2e',
    workspaceName: 'dashboard enhancement e2e',
    initialCwd: WORKSPACE_ROOT,
    ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
    ...(opts.parentCursor !== undefined ? { parentCursor: opts.parentCursor } : {}),
  }
}

function eventEntry(seq, event, effects, llmTrace, model) {
  const usage = event.usage
  return {
    kind: 'event',
    seq,
    ts: new Date().toISOString(),
    event,
    effects,
    ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheCreationTokens: usage.cacheCreationTokens ?? 0, cacheReadTokens: usage.cacheReadTokens ?? 0 } } : {}),
    ...(llmTrace ? { llmTrace } : {}),
    ...(model ? { model } : {}),
  }
}

async function replaceValue(selector, value) {
  await waitForVisible(selector)
  await page.$$eval(selector, (els, next) => {
    const el = els.find((candidate) => {
      const style = window.getComputedStyle(candidate)
      return style.display !== 'none' && style.visibility !== 'hidden' && candidate.getClientRects().length > 0
    })
    if (!el) return
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, next ?? '')
    else el.value = next ?? ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, value ?? '')
}

async function exists(selector) {
  return Boolean(await page.$(selector))
}

async function visible(selector) {
  return page.$$eval(selector, (els) => {
    return els.some((el) => {
      const style = window.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
    })
  }).catch(() => false)
}

async function waitForVisible(selector, timeoutMs = 12_000) {
  await page.waitForFunction(
    (target) => Array.from(document.querySelectorAll(target)).some((el) => {
      const style = window.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
    }),
    { timeout: timeoutMs },
    selector,
  )
}

async function textContent(selector) {
  return visibleText(selector)
}

async function visibleText(selector) {
  return page.$$eval(selector, (els) => {
    const el = els.find((candidate) => {
      const style = window.getComputedStyle(candidate)
      return style.display !== 'none' && style.visibility !== 'hidden' && candidate.getClientRects().length > 0
    })
    return el?.textContent ?? ''
  })
}

async function clickVisible(selector) {
  const handles = await page.$$(selector)
  for (const handle of handles) {
    const isVisible = await handle.evaluate((el) => {
      const style = window.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
    })
    if (isVisible) {
      await handle.click()
      return
    }
  }
  throw new Error(`no visible element for ${selector}`)
}

async function selectVisible(selector, value) {
  const handles = await page.$$(selector)
  for (const handle of handles) {
    const isVisible = await handle.evaluate((el) => {
      const style = window.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
    })
    if (isVisible) {
      await handle.select(value)
      return
    }
  }
  throw new Error(`no visible select for ${selector}`)
}

async function submitVisibleForm(selector) {
  await page.$$eval(selector, (els) => {
    const form = els.find((candidate) => {
      const style = window.getComputedStyle(candidate)
      return style.display !== 'none' && style.visibility !== 'hidden' && candidate.getClientRects().length > 0
    })
    if (!form) throw new Error(`no visible form for ${selector}`)
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

async function bodyText() {
  return page.evaluate(() => document.body.textContent ?? '')
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`)
  return res.json()
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJsonlFile(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function latestJsonFile(dir) {
  const files = readDirSync(dir).filter((file) => file.endsWith('.json')).sort()
  if (files.length === 0) throw new Error(`no json files in ${dir}`)
  return join(dir, files[files.length - 1])
}

function readDirSync(dir) {
  return existsSync(dir) ? readdirSync(dir) : []
}

function check(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}

function isExpectedConsoleError(text) {
  if (text.includes('Failed to load resource: the server responded with a status of 400')) return true
  if (text.includes('Failed to load resource: the server responded with a status of 404')) return true
  return false
}

function detectBrowser() {
  const candidates = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium']
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
