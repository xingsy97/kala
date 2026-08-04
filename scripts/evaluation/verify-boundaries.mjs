#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const boundaryPath = join(root, 'docs/architecture/agent-evaluation-package-boundaries.json')
const ownershipPath = join(root, 'docs/architecture/agent-evaluation-platform-ownership.json')
const boundaries = JSON.parse(await readFile(boundaryPath, 'utf8'))
const ownership = JSON.parse(await readFile(ownershipPath, 'utf8'))
const errors = []
const sourceSurfaceProofs = new Map([
  ['packages/host/src/http/routes.ts evaluation routes', { path: 'packages/host/src/http/routes.ts', patterns: [/['"]\/eval\//u, /src\/eval/u] }],
  ['packages/host/src/index.ts benchmark exports', { path: 'packages/host/src/index.ts', patterns: [/src\/eval/u, /benchmark-orchestrator/u] }],
])
const removedProductPaths = [
  'packages/host/src/eval',
  'packages/host/src/rl/fixtures/swebench-mini',
  'packages/host/bin/backfill-programbench-compile-probes.ts',
  'packages/host/bin/run-agent-runlab-prompt.ts',
  'packages/host/bin/run-agent-runlab-swebench.ts',
  'packages/host/bin/run-benchmark-web.ts',
  'packages/host/bin/run-browsecomp-legacy-runner.ts',
  'packages/host/bin/run-claude-code-prompt.ts',
  'packages/host/bin/run-claude-code-swebench.ts',
  'packages/host/bin/run-jobbench-legacy-runner.ts',
  'packages/host/bin/run-programbench-legacy-runner.ts',
  'packages/shared/src/benchmark-orchestrator.ts',
  'packages/shared/src/eval-types.ts',
  'packages/shared/src/swebench-types.ts',
  'packages/dashboard/src/features/benchmarks',
  'packages/dashboard/src/features/artifacts/artifact-views.tsx',
  'packages/dashboard/src/features/artifacts/BadCasesTab.tsx',
  'packages/dashboard/src/features/artifacts/BadCasesView.tsx',
  'packages/dashboard/src/features/artifacts/EvalRunsView.tsx',
  'packages/dashboard/src/features/artifacts/RunBenchmarkWizard.tsx',
  'packages/dashboard/scripts/verify-eval-no-paths.mjs',
  'packages/dashboard/scripts/verify-wizard-e2e.mjs',
  'packages/dashboard/scripts/verify-wizard-grade-and-labels.mjs',
  'scripts/eval/benchmarks',
  '.github/workflows/eval-smoke.yml',
  'docs/planning/benchmark-orchestrator.md',
  'docs/planning/benchmark-orchestrator-tasks.md',
  'docs/host/web-native-paths-implementation.md',
  'docs/capabilities/12-web-native-path-handling.md',
  'docs/evals/badcase-mining.md',
  'docs/evals/benchmark-security-model.md',
  'docs/planning/roadmap-notes/eval-moat.md',
  'docs/planning/roadmap-notes/product-polish.md',
  'docs/planning/roadmap-notes/rl-e2e.md',
  'scripts/dashboard/verify-dashboard-enhancement-actions.mjs',
  'scripts/dashboard/verify-eval-modal-scroll.mjs',
  'scripts/eval/verify-agentic-rl-dashboard.mjs',
]
for (const path of removedProductPaths) {
  if (await exists(join(root, path))) errors.push(`removed product path must not exist: ${path}`)
}

if (ownership.schemaVersion !== 2) errors.push('ownership report must use schemaVersion 2')
const evidenceCatalog = ownership.evidenceCatalog ?? {}
const deletionTestCatalog = ownership.deletionTestCatalog ?? {}
for (const [id, path] of Object.entries(evidenceCatalog)) {
  const absolute = join(root, path)
  if (!await exists(absolute)) { errors.push(`ownership evidence ${id} is missing: ${path}`); continue }
  try { JSON.parse(await readFile(absolute, 'utf8')) } catch { errors.push(`ownership evidence ${id} is not valid JSON: ${path}`) }
}
for (const [id, test] of Object.entries(deletionTestCatalog)) {
  if (!test.command || !test.source || !test.marker) { errors.push(`ownership deletion test ${id} is incomplete`); continue }
  const absolute = join(root, test.source)
  if (!await exists(absolute)) { errors.push(`ownership deletion test ${id} source is missing: ${test.source}`); continue }
  if (!(await readFile(absolute, 'utf8')).includes(test.marker)) errors.push(`ownership deletion test ${id} marker is missing from ${test.source}`)
}
for (const migration of ownership.migrationSources ?? []) {
  if (!migration.source || !migration.target || !migration.action) errors.push(`ownership migration row is incomplete: ${JSON.stringify(migration)}`)
  if (!['path', 'source-surface'].includes(migration.sourceKind)) errors.push(`ownership migration source kind is invalid: ${migration.source}`)
  if (!Array.isArray(migration.targetPaths) || migration.targetPaths.length === 0) errors.push(`ownership migration target paths are missing: ${migration.source}`)
  for (const targetPath of migration.targetPaths ?? []) if (!await exists(join(root, targetPath))) errors.push(`ownership migration target is missing for ${migration.source}: ${targetPath}`)
  if (!Array.isArray(migration.compatibilityEvidence) || migration.compatibilityEvidence.length === 0) errors.push(`ownership compatibility evidence is missing: ${migration.source}`)
  for (const evidence of migration.compatibilityEvidence ?? []) if (!evidenceCatalog[evidence]) errors.push(`ownership compatibility evidence is unknown for ${migration.source}: ${evidence}`)
  if (!Array.isArray(migration.deletionTests) || migration.deletionTests.length === 0) errors.push(`ownership deletion tests are missing: ${migration.source}`)
  for (const test of migration.deletionTests ?? []) if (!deletionTestCatalog[test]) errors.push(`ownership deletion test is unknown for ${migration.source}: ${test}`)
  if (migration.sourceKind === 'path' && await exists(join(root, migration.source))) errors.push(`removed migration source must not exist: ${migration.source}`)
  if (migration.sourceKind === 'source-surface') {
    const proof = sourceSurfaceProofs.get(migration.source)
    if (!proof) { errors.push(`ownership source surface has no executable proof: ${migration.source}`); continue }
    const body = await readFile(join(root, proof.path), 'utf8')
    for (const pattern of proof.patterns) if (pattern.test(body)) errors.push(`${migration.source} retains forbidden source surface ${pattern}`)
  }
}

const forbiddenProductSource = new Map([
  ['packages/shared/src/protocol.ts', [/\bbenchmarks\s*:/u, /\bevaluations\s*:/u]],
  ['packages/host/src/http/routes.ts', [/['"]\/eval\//u, /src\/eval/u]],
  ['packages/host/src/ops-cli.ts', [/eval-bench/u, /benchmark-cli/u]],
  ['packages/host/src/index.ts', [/src\/eval/u, /benchmark-orchestrator/u]],
  ['packages/host/bin/agent-kernel-host.ts', [/eval-bench/u, /benchmark-cli/u]],
  ['packages/dashboard/src/app.tsx', [/#\/benchmarks/u, /features\/benchmarks/u]],
  ['packages/dashboard/src/app-shell/section.ts', [/benchmarks/u, /evaluations/u]],
  ['packages/dashboard/src/app-shell/AppShellNav.tsx', [/benchmarks/u, /evaluations/u]],
  ['packages/dashboard/src/features/pipeline/PipelinePage.tsx', [/benchmarkSteps/u, /pipeline-tab-benchmark/u]],
])
for (const [path, patterns] of forbiddenProductSource) {
  const absolute = join(root, path)
  if (!await exists(absolute)) { errors.push(`missing clean-cutover source: ${path}`); continue }
  const body = await readFile(absolute, 'utf8')
  for (const pattern of patterns) if (pattern.test(body)) errors.push(`${path} retains forbidden product evaluation entry ${pattern}`)
}

const removedRunnerNames = [
  'run-agent-runlab-prompt',
  'run-agent-runlab-swebench',
  'run-benchmark-web',
  'run-browsecomp-legacy-runner',
  'run-claude-code-prompt',
  'run-claude-code-swebench',
  'run-jobbench-legacy-runner',
  'run-programbench-legacy-runner',
  'backfill-programbench-compile-probes',
]
for (const base of ['scripts/deploy', 'scripts/release']) {
  for (const file of await sourceFiles(join(root, base))) {
    if (file.endsWith('/verify-release-assets.mjs')) continue // This verifier intentionally names forbidden release entries.
    const body = await readFile(file, 'utf8')
    for (const runner of removedRunnerNames) if (body.includes(runner)) errors.push(`${relative(root, file)} retains removed runner ${runner}`)
  }
}
for (const path of ['package.json', '.github/workflows/ci.yml', 'packages/host/src/runtime-config.ts', 'scripts/evaluation/run-real-task-pack.mjs']) {
  const body = await readFile(join(root, path), 'utf8')
  for (const forbidden of ['scripts/eval/benchmarks', 'experiments/evals', 'verify:swebench-smoke', 'benchmarks:sync-env', 'benchmarks:preflight', 'benchmarks:validate']) {
    if (body.includes(forbidden)) errors.push(`${path} retains old evaluation discovery/entry ${forbidden}`)
  }
}
const packageByName = new Map()
for (const packageJson of await packageJsonFiles()) {
  const manifest = JSON.parse(await readFile(packageJson, 'utf8'))
  if (typeof manifest.name === 'string') packageByName.set(manifest.name, { packageJson, manifest })
}

for (const rule of boundaries.rules) {
  const packagePaths = rule.package.endsWith('/*')
    ? await childDirectories(join(root, rule.package.slice(0, -2)))
    : [join(root, rule.package)]
  for (const packagePath of packagePaths) {
    const manifestPath = join(packagePath, 'package.json')
    if (!await exists(manifestPath)) { errors.push(`missing package for boundary rule: ${relative(root, packagePath)}`); continue }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }
    const workspaceDependencies = Object.keys(dependencies).filter((name) => packageByName.has(name))
    for (const dependency of workspaceDependencies) {
      const exact = rule.allowedWorkspaceDependencies?.includes(dependency) ?? false
      const prefix = rule.allowedWorkspaceDependencyPrefixes?.some((candidate) => dependency.startsWith(candidate)) ?? false
      if (!exact && !prefix) errors.push(`${relative(root, packagePath)} has forbidden workspace dependency ${dependency}`)
    }
  }
}

for (const rule of boundaries.forbiddenSourceImports) {
  for (const source of rule.from) {
    const sourceRoot = join(root, source)
    if (!await exists(sourceRoot)) continue
    for (const file of await sourceFiles(sourceRoot)) {
      const body = await readFile(file, 'utf8')
      for (const pattern of rule.patterns) {
        if (body.includes(pattern)) errors.push(`${relative(root, file)} contains forbidden source import pattern ${pattern}`)
      }
    }
  }
}

if (ownership.cleanCutover.legacyReadPolicy !== 'reject-and-never-discover') errors.push('ownership manifest must declare reject-and-never-discover')
if (ownership.cleanCutover.authoritativeWriter !== 'packages/eval-orchestrator') errors.push('ownership manifest must name the sole authoritative writer')
const forbiddenEntries = ownership.cleanCutover.forbiddenCompatibilityEntries ?? []
if (!forbiddenEntries.includes('legacy-v1')) errors.push('ownership manifest must explicitly forbid legacy-v1')
for (const target of ownership.targetOwners) {
  if (!await exists(join(root, target.owner)) && !['packages/eval-analyzer', 'packages/eval-dashboard'].includes(target.owner)) {
    errors.push(`declared target owner is missing: ${target.owner}`)
  }
}

if (errors.length > 0) {
  process.stderr.write(errors.map((error) => `- ${error}`).join('\n') + '\n')
  process.exit(1)
}
process.stdout.write(JSON.stringify({ ok: true, boundaryRules: boundaries.rules.length, sourceRules: boundaries.forbiddenSourceImports.length, ownershipSources: ownership.migrationSources.length }) + '\n')

async function packageJsonFiles() {
  const results = []
  for (const base of ['packages', 'adapters']) {
    const directory = join(root, base)
    if (!await exists(directory)) continue
    for (const file of await walk(directory)) if (file.endsWith('/package.json') && !file.includes('/node_modules/')) results.push(file)
  }
  return results
}
async function sourceFiles(directory) {
  return (await walk(directory)).filter((file) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(file) && !file.includes('/dist/') && !file.includes('/node_modules/'))
}
async function childDirectories(directory) {
  if (!await exists(directory)) return []
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name))
}
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
async function exists(path) { try { return (await stat(path)).isDirectory() || (await stat(path)).isFile() } catch { return false } }
