#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-control-plane-authority-'))
try {
  const reportPath = join(temporary, 'control-plane.json')
  await runFile('pnpm', ['--dir', 'packages/eval-orchestrator', 'exec', 'vitest', 'run', 'src/control-plane.test.ts', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const assertions = report.testResults.flatMap((file) => file.assertionResults)
  const requiredTests = [
    required(assertions, 'atomically commits idempotent commands and rebuilds the same projection after restart'),
    required(assertions, 'durably accepts only ordered progress transitions from the Worker holding the lease'),
    required(assertions, 'ignores a torn trailing transaction rather than projecting uncommitted state'),
    required(assertions, 'rejects non-trailing journal tampering through the durable transaction hash chain'),
    required(assertions, 'restores the task and evaluated-slice catalog from the sole durable journal without startup catalog input'),
    required(assertions, 'persists authoritative analysis jobs, validates output manifests, and replays terminal job state'),
    required(assertions, 'aggregates result usage, auto-finalizes a run, and persists the projection across restart'),
  ]

  const writerMarkers = ['DurableJournal', 'ControlPlaneProjection', 'JournalTransactionSchema', 'control-plane.jsonl', 'journal.append(', 'projection.apply(', 'projection.replay(']
  const auditedRoots = ['packages', 'adapters']
  const writerFiles = new Set()
  let productionSourceFilesAudited = 0
  for (const base of auditedRoots) {
    for (const path of await walk(join(root, base))) {
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(path) || /\.test\.[^.]+$/u.test(path) || path.includes('/dist/') || path.includes('/node_modules/')) continue
      productionSourceFilesAudited += 1
      const body = await readFile(path, 'utf8')
      if (writerMarkers.some((marker) => body.includes(marker))) writerFiles.add(relative(root, path))
    }
  }
  const expectedWriterFiles = [
    'packages/eval-orchestrator/bin/eval-orchestrator.ts',
    'packages/eval-orchestrator/src/control-plane.ts',
    'packages/eval-orchestrator/src/journal.ts',
    'packages/eval-orchestrator/src/model.ts',
    'packages/eval-orchestrator/src/projection.ts',
  ]
  if (JSON.stringify([...writerFiles].sort()) !== JSON.stringify(expectedWriterFiles)) {
    throw new Error('durable writer surface differs from the sole eval-orchestrator authority: ' + JSON.stringify([...writerFiles].sort()))
  }
  const ownership = JSON.parse(await readFile(join(root, 'docs/architecture/agent-evaluation-platform-ownership.json'), 'utf8'))
  if (ownership.cleanCutover?.authoritativeWriter !== 'packages/eval-orchestrator') throw new Error('ownership manifest does not name eval-orchestrator as authoritative writer')
  if (!ownership.targetOwners.some((entry) => entry.capability === 'orchestration-and-durable-state' && entry.owner === 'packages/eval-orchestrator')) throw new Error('durable-state ownership is not assigned to eval-orchestrator')

  const sourcePaths = [
    ...expectedWriterFiles,
    'packages/eval-orchestrator/src/control-plane.test.ts',
    'docs/architecture/agent-evaluation-package-boundaries.json',
    'docs/architecture/agent-evaluation-platform-ownership.json',
    'scripts/evaluation/verify-control-plane-authority.mjs',
  ]
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(join(root, path)))])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'sole durable run, trial, accepted-spec, event, result, analysis, catalog, and projection authority',
    sourceRevision,
    sourceFiles,
    sourceAudit: { auditedRoots, productionSourceFilesAudited, writerFiles: [...writerFiles].sort(), authoritativeWriter: ownership.cleanCutover.authoritativeWriter, secondWriterFound: false },
    requiredTests,
    durability: { atomicAppendThenApply: true, restartReplay: true, tornTrailingTransactionExcluded: true, hashChainTamperingRejected: true, catalogReplay: true, analysisReplay: true, runTrialResultReplay: true },
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, requiredTests: requiredTests.length, productionSourceFilesAudited, writerFiles: evidence.sourceAudit.writerFiles, secondWriterFound: false, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function required(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required authority test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
async function walk(directory) {
  const results = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) results.push(...await walk(path))
    else if (entry.isFile()) results.push(path)
  }
  return results
}
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
