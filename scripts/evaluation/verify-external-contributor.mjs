#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-external-contributor-'))

try {
  const before = await sourceHashes(['packages/eval-orchestrator', 'packages/eval-worker/src/plugin-loader.ts', 'packages/eval-analyzer/src/detector-plugins.ts'])
  await command('pnpm', ['--filter', '@agent-kernel/eval-protocol', 'build'])
  await command('pnpm', ['--filter', '@agent-kernel/eval-sdk', 'build'])
  const packDirectory = join(temporary, 'packages')
  await mkdir(packDirectory, { recursive: true })
  await command('pnpm', ['--dir', 'packages/eval-protocol', 'pack', '--pack-destination', packDirectory])
  await command('pnpm', ['--dir', 'packages/eval-sdk', 'pack', '--pack-destination', packDirectory])
  const archives = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'))
  const protocolArchive = join(packDirectory, requiredArchive(archives, 'eval-protocol'))
  const sdkArchive = join(packDirectory, requiredArchive(archives, 'eval-sdk'))
  const installed = []
  for (const template of ['agent-adapter', 'task-pack', 'sandbox-provider', 'detector']) {
    const destination = join(temporary, 'clean-workspaces', template)
    await cp(join(root, 'packages/eval-sdk/templates', template), destination, { recursive: true })
    await command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', protocolArchive, sdkArchive], { cwd: destination, timeout: 120_000 })
    await command('npm', ['run', 'build'], { cwd: destination })
    installed.push({ template, package: JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')).name, plugin: await inspectPlugin(join(destination, 'dist/index.js'), join(destination, 'node_modules/@agent-kernel/eval-sdk/dist/index.js')) })
  }

  const taskFixture = JSON.parse(await readFile(join(temporary, 'clean-workspaces/task-pack/fixtures/tasks.json'), 'utf8'))
  const taskSdk = await import(pathUrl(join(temporary, 'clean-workspaces/task-pack/node_modules/@agent-kernel/eval-sdk/dist/index.js')))
  const parsedTasks = taskFixture.tasks.map((task) => taskSdk.ResolvedTaskSchema.parse(task))
  if (parsedTasks.length !== 1 || parsedTasks[0].taskPackId !== 'example:sample-task-pack') throw new Error('task-pack synthetic fixture did not pass the public SDK schema')
  const detectorCorpus = JSON.parse(await readFile(join(temporary, 'clean-workspaces/detector/fixtures/corpus.json'), 'utf8'))
  if (!Array.isArray(detectorCorpus.cases) || !detectorCorpus.cases.some((entry) => entry.expectedFinding === true) || !detectorCorpus.cases.some((entry) => entry.expectedFinding === false)) throw new Error('detector corpus must include positive and negative synthetic cases')
  const detectorPlugin = (await import(pathUrl(join(temporary, 'clean-workspaces/detector/dist/index.js')))).evaluationPlugins[0]
  const detectorResults = []
  for (const entry of detectorCorpus.cases) {
    const findings = await detectorPlugin.create().analyze(analyzerInput(entry.caseId, entry.events))
    detectorResults.push({ caseId: entry.caseId, expectedFinding: entry.expectedFinding, findings: findings.length })
    if ((findings.length > 0) !== entry.expectedFinding) throw new Error('detector corpus expectation failed: ' + entry.caseId)
  }

  const privateImportScan = await scanPrivateImports(join(root, 'packages/eval-sdk/templates'))
  if (privateImportScan.length) throw new Error('starter contains private implementation import: ' + JSON.stringify(privateImportScan))
  const documentation = await verifyDocumentation()
  const after = await sourceHashes(['packages/eval-orchestrator', 'packages/eval-worker/src/plugin-loader.ts', 'packages/eval-analyzer/src/detector-plugins.ts'])
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('clean contributor acceptance modified runtime internals')

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'clean temporary workspaces using packed public eval-protocol/eval-sdk plus public npm dependencies; no workspace links or orchestrator source imports',
    publicPackages: { protocol: await fileEvidence(protocolArchive), sdk: await fileEvidence(sdkArchive) },
    cleanWorkspaces: installed,
    fixtureValidation: { tasks: parsedTasks.map((task) => task.taskId), taskPolicy: parsedTasks[0].policy, detectorCases: detectorResults, license: detectorCorpus.license, evaluationPermission: detectorCorpus.evaluationPermission },
    runtimeLoading: { workerExportContract: 'evaluationPlugins', analyzerExportContract: 'evaluationPlugins', externalAgentsUnranked: true, officialRequiredRejected: true },
    privateImportScan,
    documentation,
    orchestratorInternalsUnchanged: true,
    runtimeSourceHashes: after,
  }
  const output = resolve(option('--output') ?? 'docs/evidence/evaluation/external-contributor-acceptance-20260803.json')
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  await writeFile(output, JSON.stringify(evidence, null, 2) + String.fromCharCode(10), { mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, cleanWorkspaces: installed.length, taskFixtures: parsedTasks.length, detectorCases: detectorResults.length, privateImports: privateImportScan.length, output }) + String.fromCharCode(10))
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function inspectPlugin(path, sdkPath) {
  const module = await import(pathUrl(path))
  const sdk = await import(pathUrl(sdkPath))
  if (!Array.isArray(module.evaluationPlugins) || module.evaluationPlugins.length !== 1) throw new Error('starter must export exactly one evaluation plugin: ' + path)
  const plugin = module.evaluationPlugins[0]
  const id = plugin?.kind === 'sandbox-provider' ? plugin?.descriptor?.providerId : plugin?.descriptor?.id
  if (!id || !id.includes(':') || !plugin.descriptor.version || !Array.isArray(plugin.descriptor.protocolVersions)) throw new Error('starter plugin descriptor/version/namespaced ID is invalid: ' + path)
  const negotiation = sdk.negotiateEvaluationPlugin(plugin)
  sdk.assertPluginMatchesDescriptor(plugin)
  return { kind: plugin.kind, id, version: plugin.descriptor.version, protocolVersions: plugin.descriptor.protocolVersions, negotiation, ...(plugin.kind === 'agent-backend' ? { ranked: plugin.descriptor.ranked } : {}) }
}
async function verifyDocumentation() {
  const required = [
    ['docs/evaluation/CONTRIBUTING.md', ['public @agent-kernel/eval-sdk', 'verify:evaluation-contributor', 'precision/recall']],
    ['docs/evaluation/SECURITY.md', ['credential reference', 'denied-by-default network', 'symlinks']],
    ['docs/evaluation/COMPATIBILITY.md', ['protocolVersions', 'capabilities', 'namespaced', 'isolated', 'unranked', 'no legacy-v1']],
    ['docs/evaluation/RELEASING.md', ['pack', 'Rollback', 'fresh runs']],
    ['deploy/evaluation/README.md', ['docker compose', '/healthz']],
  ]
  return await Promise.all(required.map(async ([path, terms]) => {
    const source = await readFile(join(root, path), 'utf8')
    for (const term of terms) if (!source.toLowerCase().includes(term.toLowerCase())) throw new Error('required documentation term is missing from ' + path + ': ' + term)
    return { path, sha256: digest(source), requiredTerms: terms }
  }))
}
async function scanPrivateImports(directory) {
  const findings = []
  for (const path of await files(directory)) {
    if (!/.(?:ts|js|mjs|json|md)$/u.test(path)) continue
    const source = await readFile(path, 'utf8')
    for (const forbidden of ['@agent-kernel/eval-orchestrator', '@agent-kernel/eval-worker', '@agent-kernel/eval-analyzer', '@agent-kernel/eval-sdk/', 'packages/host', '../../src/', '../../../src/']) if (source.includes(forbidden)) findings.push({ path: relative(root, path), forbidden })
  }
  return findings
}
async function files(directory) { const output = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) output.push(...await files(path)); else if (entry.isFile()) output.push(path) } return output.sort() }
async function sourceHashes(paths) { const expanded = []; for (const path of paths) { const absolute = join(root, path); const listed = await readdir(absolute, { withFileTypes: true }).catch(() => []); const selected = listed.length ? await files(absolute) : [absolute]; for (const file of selected) if (!file.includes('/dist/') && !file.includes('/node_modules/')) expanded.push({ path: relative(root, file), sha256: digest(await readFile(file)) }) } return expanded.sort((left, right) => left.path.localeCompare(right.path)) }
async function fileEvidence(path) { const bytes = await readFile(path); return { name: path.split('/').at(-1), bytes: bytes.byteLength, sha256: digest(bytes) } }
function analyzerInput(caseId, events) { return { schemaVersion: 1, runId: 'sample-run', trialId: 'sample-' + caseId, taskId: 'sample-task', events, constraints: [], constraintLifecycle: [], memoryProbes: [], toolAttempts: [], planSteps: [], workspaceIntegrity: { changedPaths: [], deletedPaths: [], protectedPaths: [], hiddenVerifierPaths: [], verifierLeakagePaths: [], suspiciousLiteralEvidenceRefs: [] }, verifierIntegrity: { passed: true, protectedIntegrityPassed: true, hiddenVerifierPassed: true, selectedTestFraction: 1, evidenceRefs: ['synthetic:verifier'] }, inputManifestHash: 'a'.repeat(64) } }
function requiredArchive(names, part) { const matches = names.filter((name) => name.includes(part)); if (matches.length !== 1) throw new Error('expected one packed ' + part + ' archive'); return matches[0] }
function command(binary, args, options = {}) { return runFile(binary, args, { cwd: options.cwd ?? root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: options.timeout ?? 60_000 }) }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function pathUrl(path) { return new URL('file://' + path).href }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) { if (process.argv[index] === name) return process.argv[index + 1]; if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) } }
