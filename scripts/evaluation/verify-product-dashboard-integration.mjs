#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-product-dashboard-integration-'))
try {
  const reportPath = join(temporary, 'dashboard.json')
  await runFile('pnpm', ['--dir', 'packages/dashboard', 'exec', 'vitest', 'run', 'src/evaluation-integration.test.ts', 'src/app-shell/AppShellNav.test.tsx', 'src/features/chat/SessionMetadataDialog.test.tsx', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const assertions = report.testResults.flatMap((file) => file.assertionResults)
  const requiredTests = [
    required(assertions, 'renders nav tabs and marks the active section'),
    required(assertions, 'exports a governed private reference and links only an explicit evaluation reference'),
    required(assertions, 'does not infer an evaluation link without an explicit session-scoped reference'),
    required(assertions, 'uses the standalone default URL and accepts an explicit HTTP URL'),
    required(assertions, 'rejects non-HTTP and malformed configured URLs'),
    required(assertions, 'creates links only from an explicit reference scoped to the same session'),
    required(assertions, 'exports only a governed reference without session content or workspace paths'),
  ]
  const sourcePaths = [
    'packages/dashboard/src/evaluation-integration.ts', 'packages/dashboard/src/evaluation-integration.test.ts',
    'packages/dashboard/src/app-shell/AppShellNav.tsx', 'packages/dashboard/src/app-shell/AppShellNav.test.tsx',
    'packages/dashboard/src/features/chat/SessionMetadataDialog.tsx', 'packages/dashboard/src/features/chat/SessionMetadataDialog.test.tsx',
    'scripts/evaluation/verify-product-dashboard-integration.mjs',
  ]
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')])))
  const evidence = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    scope: 'the three permitted Product Dashboard integration links only; no evaluation state, benchmark route, artifact browser, forwarding API, or legacy compatibility reader',
    requiredTests, sourceHashes,
    integrations: { standalonePlatformLink: true, governedSessionTaskCandidateExport: true, explicitSessionScopedRunDefectLink: true },
    privacy: { contentIncluded: false, workspacePathIncluded: false, privateOnly: true, explicitReviewRequired: true, redactionAndProvenanceApprovalRequired: true },
    security: { httpHttpsOnly: true, invalidConfiguredUrlFallsBackToLocalStandalone: true, inferredEvaluationLinkRejected: true },
  }
  const output = option('--output')
  if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, JSON.stringify(evidence, null, 2) + String.fromCharCode(10), { mode: 0o600 }) }
  process.stdout.write(JSON.stringify({ ok: true, integrations: Object.keys(evidence.integrations), requiredTests: requiredTests.length, output: output ? resolve(output) : undefined }) + String.fromCharCode(10))
} finally { await rm(temporary, { recursive: true, force: true }) }

function required(assertions, title) { const matches = assertions.filter((assertion) => assertion.title === title); if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required Product Dashboard integration test did not pass exactly once: ' + title); return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration } }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
