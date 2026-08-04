#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-adapters-'))

try {
  const reportPath = join(temporary, 'vitest.json')
  const testFiles = [
    'adapters/agents/certification/src/official-agents.test.ts',
    'adapters/agents/agent-runlab/src/index.test.ts',
    'adapters/agents/agent-runlab/src/driver-readiness.test.ts',
    'adapters/agents/claude-code/src/index.test.ts',
    'adapters/agents/codex/src/index.test.ts',
    'adapters/agents/codex/src/provider-config.test.ts',
    'adapters/agents/custom-command/src/index.test.ts',
    'packages/eval-protocol/src/protocol.test.ts',
  ]
  await runFile('pnpm', ['exec', 'vitest', 'run', ...testFiles, '--reporter=json', '--outputFile=' + reportPath], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const assertions = report.testResults.flatMap((file) => file.assertionResults)
  const certification = assertions.filter((assertion) => /official Agent certification (?:[1-9]|10)\./u.test(assertion.fullName))
  if (certification.length !== 30 || certification.some((assertion) => assertion.status !== 'passed')) throw new Error('the shared three-Agent certification suite did not pass 30/30')

  const requiredTests = [
    required(assertions, 'AgentRunLabBackend captures public wire events, usage, versions, final response, and diff'),
    required(assertions, 'ClaudeCodeAgentBackend sandbox user selection refuses to run Claude Code as root when no unprivileged account exists'),
    required(assertions, 'CodexAgentBackend transport isolation uses the formal app-server driver with an isolated Codex home by default'),
    required(assertions, 'CodexAgentBackend transport isolation uses ephemeral exec-json fallback without reading user config or session state'),
    required(assertions, 'CustomCommandAgentBackend is a non-ranked public plugin and records command events plus the final diff'),
    required(assertions, 'dataset slices and Leaderboard authority enforces the complete Leaderboard eligibility and comparability identity matrix'),
    required(assertions, 'canonical protocol v1 rejects development-only backends from official-required run specs'),
  ]

  const runLabPackage = await json('adapters/agents/agent-runlab/package.json')
  const runLabDependencies = Object.keys(runLabPackage.dependencies ?? {}).sort()
  const allowedRunLabDependencies = ['@agent-kernel/eval-protocol', '@agent-kernel/eval-sdk', '@agent-kernel/shared', 'socket.io-client']
  if (JSON.stringify(runLabDependencies) !== JSON.stringify(allowedRunLabDependencies)) throw new Error('Agent RunLab production dependency boundary changed')
  const runLabSourceFiles = (await walk(resolve(root, 'adapters/agents/agent-runlab'))).filter(sourceFile)
  const forbiddenRunLabImports = ['@agent-kernel/host', '@agent-kernel/dashboard', 'packages/host', '/src/eval/', 'src/eval/']
  for (const path of runLabSourceFiles) {
    const body = await readFile(path, 'utf8')
    for (const marker of forbiddenRunLabImports) if (body.includes(marker)) throw new Error(relative(root, path) + ' imports a private product evaluation surface: ' + marker)
  }
  const runLabSource = await source('adapters/agents/agent-runlab/src/index.ts')
  const runLabDriver = await source('adapters/agents/agent-runlab/bin/runlab-trial-driver.ts')
  for (const marker of ['DashboardClientToServerEvents', 'DashboardServerToClientEvents', 'client:create_session', 'client:user_message']) if (!runLabDriver.includes(marker)) throw new Error('Agent RunLab public wire integration is missing ' + marker)
  if (!runLabSource.includes("extraArtifactPaths: ['runlab-session.jsonl', 'runlab-native.tar']")) throw new Error('Agent RunLab native evidence declaration is missing')

  const claudeSource = await source('adapters/agents/claude-code/src/index.ts')
  for (const marker of ['--output-format', 'stream-json', '--no-session-persistence', '--strict-mcp-config', 'CLAUDE_CONFIG_DIR', "['runuser', '-u'"]) if (!claudeSource.includes(marker)) throw new Error('Claude Code isolated native CLI integration is missing ' + marker)

  const codexSource = await source('adapters/agents/codex/src/index.ts')
  const codexDriver = await source('adapters/agents/codex/bin/codex-app-server-driver.ts')
  for (const marker of ['agent-eval-codex-app-server', "config.transport === 'exec-json'", '--ephemeral', '--ignore-user-config', '--ignore-rules', "CODEX_HOME: '/tmp/agent-home/codex'"]) if (!codexSource.includes(marker)) throw new Error('Codex dual transport or isolation marker is missing: ' + marker)
  for (const marker of ["rpc('initialize'", "rpc('thread/start'", "rpc('turn/start'", "message.method === 'turn/completed'"]) if (!codexDriver.includes(marker)) throw new Error('Codex app-server protocol marker is missing: ' + marker)

  const customSource = await source('adapters/agents/custom-command/src/index.ts')
  if (!customSource.includes("id: 'custom-command'") || !customSource.includes('ranked: false')) throw new Error('custom-command is not permanently declared non-ranked')
  const leaderboardSource = await source('packages/eval-protocol/src/leaderboard.ts')
  if (!leaderboardSource.includes("z.enum(['agent-runlab', 'claude-code', 'codex'])")) throw new Error('Leaderboard admits a non-official Agent type')

  const agentAdapterDirectories = (await readdir(resolve(root, 'adapters/agents'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  if (agentAdapterDirectories.includes('smoke')) throw new Error('smoke backend must remain protocol-only and absent from publishable Agent adapters')
  const smokeRuntimeHits = []
  for (const base of ['adapters', 'deploy/evaluation', 'packages/eval-worker']) {
    for (const path of (await walk(resolve(root, base))).filter(sourceOrManifestFile)) {
      if (/\.(?:test|spec)\.[^.]+$/u.test(path)) continue
      const body = await readFile(path, 'utf8')
      if (/backendId\s*:\s*['"]smoke['"]|id\s*:\s*['"]smoke['"]|eval-agent-smoke/u.test(body)) smokeRuntimeHits.push(relative(root, path))
    }
  }
  if (smokeRuntimeHits.length > 0) throw new Error('smoke backend has a publishable runtime entry: ' + smokeRuntimeHits.join(', '))

  const sdlc = await json('docs/evidence/evaluation/final-fresh-sdlc-journey-20260803.json')
  const sweBench = await json('docs/evidence/evaluation/final-fresh-swe-bench-astropy-12907-20260803.json')
  const officialAgents = ['agent-runlab', 'claude-code', 'codex']
  for (const [label, evidence] of [['SDLC', sdlc], ['SWE-Bench', sweBench]]) {
    const agents = evidence.trials.map((trial) => trial.agentVariantId).sort()
    if (evidence.runState !== 'completed' || evidence.cleanupVerified !== true || evidence.freshSandboxes !== 3 || JSON.stringify(agents) !== JSON.stringify(officialAgents)) throw new Error(label + ' fresh three-Agent evidence is incomplete')
    if (evidence.trials.some((trial) => trial.normalizedEventCount < 1)) throw new Error(label + ' has an empty native/normalized Agent trace')
  }
  const claudeSdlc = sdlc.trials.find((trial) => trial.agentVariantId === 'claude-code')
  const claudeSweBench = sweBench.trials.find((trial) => trial.agentVariantId === 'claude-code')
  if (claudeSdlc?.nativeMetrics?.passedSteps !== 8 || claudeSweBench?.nativeMetrics?.resolved !== true) throw new Error('Claude Code real native evidence is incomplete')

  const appServer = await json('docs/evidence/evaluation/codex-app-server-acceptance-20260803.json')
  const execJson = await json('docs/evidence/evaluation/codex-exec-json-fallback-acceptance-20260803.json')
  validateCodexRun(appServer, 'app-server')
  validateCodexRun(execJson, 'exec-json')
  if (appServer.runId === execJson.runId) throw new Error('Codex transports did not use distinct fresh Sessions')

  const sourcePaths = [
    ...runLabSourceFiles.map((path) => relative(root, path)),
    'adapters/agents/agent-runlab/package.json',
    'adapters/agents/claude-code/src/index.ts',
    'adapters/agents/codex/src/index.ts',
    'adapters/agents/codex/bin/codex-app-server-driver.ts',
    'adapters/agents/codex/src/index.test.ts',
    'adapters/agents/custom-command/src/index.ts',
    'packages/eval-protocol/src/agent-backend.ts',
    'packages/eval-protocol/src/leaderboard.ts',
    'packages/eval-protocol/src/protocol.test.ts',
    'scripts/evaluation/run-real-task-pack.mjs',
    'scripts/evaluation/verify-agent-adapters.mjs',
  ]
  const evidencePaths = [
    'docs/evidence/evaluation/final-fresh-sdlc-journey-20260803.json',
    'docs/evidence/evaluation/final-fresh-swe-bench-astropy-12907-20260803.json',
    'docs/evidence/evaluation/codex-app-server-acceptance-20260803.json',
    'docs/evidence/evaluation/codex-exec-json-fallback-acceptance-20260803.json',
  ]
  const sourceFiles = Object.fromEntries(await Promise.all([...new Set(sourcePaths)].sort().map(async (path) => [path, await fileSha256(path)])))
  const evidenceFiles = Object.fromEntries(await Promise.all(evidencePaths.map(async (path) => [path, await fileSha256(path)])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'official Agent adapter public-boundary, certification, isolation, dual-transport, ranking, publication, and fresh real-run acceptance',
    sourceRevision,
    sourceFiles,
    evidenceFiles,
    tests: { passed: assertions.filter((assertion) => assertion.status === 'passed').length, required: requiredTests, officialCertification: { passed: certification.length, expected: 30 } },
    acceptance: {
      agentRunLabPublicRuntimeOnly: true,
      claudeCodeIsolatedNativeCli: true,
      codexTransports: { appServerRunId: appServer.runId, execJsonRunId: execJson.runId, distinctFreshSessions: true },
      customCommandRanked: false,
      smokeBackend: 'protocol-only-not-published',
      freshThreeAgentRuns: [sdlc.runId, sweBench.runId],
    },
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, tests: evidence.tests.passed, certification: certification.length, runLabSourceFiles: runLabSourceFiles.length, codexFreshTransports: 2, customCommandRanked: false, smokeBackendPublished: false, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function required(assertions, fullName) {
  const matches = assertions.filter((assertion) => assertion.fullName === fullName)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required adapter test did not pass exactly once: ' + fullName)
  return { test: fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function validateCodexRun(run, transport) {
  const config = run.agentConfigs?.find((agent) => agent.variantId === 'codex')
  const trial = run.trials?.find((candidate) => candidate.agentVariantId === 'codex')
  if (!run.runId?.startsWith('fresh-') || run.runState !== 'completed' || run.freshSandboxes !== 1 || run.cleanupVerified !== true || run.workerErrors?.length !== 0) throw new Error('Codex ' + transport + ' fresh-run lifecycle evidence is incomplete')
  if (config?.config?.transport !== transport || config.configHash?.length !== 64) throw new Error('Codex ' + transport + ' immutable config evidence is incomplete')
  if (trial?.nativeMetrics?.journey_completed !== true || trial.nativeMetrics.passedSteps !== 8 || trial.normalizedEventCount < 1) throw new Error('Codex ' + transport + ' native result evidence is incomplete')
}
async function source(path) { return await readFile(resolve(root, path), 'utf8') }
async function json(path) { return JSON.parse(await source(path)) }
async function fileSha256(path) { return createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') }
async function walk(directory) {
  const results = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) results.push(...await walk(path))
    else if (entry.isFile() && (await stat(path)).isFile()) results.push(path)
  }
  return results
}
function sourceFile(path) { return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(path) && !/\.(?:test|spec)\.[^.]+$/u.test(path) }
function sourceOrManifestFile(path) { return sourceFile(path) || /(?:package\.json|Dockerfile[^/]*)$/u.test(path) || /\.(?:ya?ml)$/u.test(path) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
