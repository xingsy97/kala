#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const design = await json('docs/evaluation/benchmark-design-manifest.json')
const templates = await json('deploy/evaluation/run-templates.json')
const catalog = await json('deploy/evaluation/catalog.json')
const catalogBuilder = await readFile(resolve(root, 'scripts/evaluation/build-deployment-catalog.mjs'), 'utf8')
const inventory = await json('docs/evaluation/canonical-pack-inventory.json')
const expectedAgents = ['agent-runlab', 'claude-code', 'codex']
const expectedPacks = inventory.packs.map((pack) => pack.id).sort()

assert(design.schemaVersion === 1, 'unsupported benchmark design manifest schema')
assert(equal(design.agents, expectedAgents), 'design must declare exactly the three ranked Agents')
assert(Object.values(design.pairing ?? {}).every((value) => value === true), 'all same-task pairing controls must be required')
assert(equal([...design.packs.map((pack) => pack.id)].sort(), expectedPacks), 'design pack inventory must equal the canonical inventory')
assert(equal([...templates.filter((template) => template.kind === 'benchmark').map((template) => template.spec.taskPack.id)].sort(), expectedPacks), 'deployment templates must equal the canonical inventory')
validateCleanup(design.cleanupSchema)
validateComparisonPolicy(design)

for (const pack of design.packs) {
  const template = templates.find((candidate) => candidate.spec?.taskPack?.id === pack.id)
  assert(template, 'missing deployment template for ' + pack.id)
  const spec = template.spec
  const slice = spec.taskPack.evaluatedSlice
  const entry = catalog.find((candidate) => candidate.sliceManifestHash === slice.sliceManifestHash)
  assert(entry, 'missing catalog slice for ' + pack.id)
  assert(equal(spec.agents.map((agent) => agent.variantId), expectedAgents), pack.id + ' must run all three Agents on the same task list')
  assert(spec.sandbox.provider === pack.containerSubset.provider, pack.id + ' container provider differs from design')
  assert(spec.sandbox.imageDigest === (pack.id === 'swe-bench' ? 'lxd-image.invalid/swe-bench' : 'lxd-image.invalid/base'), pack.id + ' deployment template must use the render-time image marker')
  assert(!/local:[a-f0-9]{64}/u.test(catalogBuilder), 'catalog builder must not commit installation-specific LXD fingerprints')
  assert(equal(template.builder.taskIds, pack.containerSubset.taskIds), pack.id + ' template task IDs differ from design')
  assert(equal(entry.tasks.map((task) => task.taskId), pack.containerSubset.taskIds), pack.id + ' catalog task IDs differ from design')
  assert(slice.selectionKind === pack.containerSubset.selectionKind, pack.id + ' selection kind differs from design')
  assert(slice.dataset.datasetId === pack.dataset.id && slice.dataset.version === pack.dataset.version && slice.dataset.sourceRevision === pack.dataset.revision, pack.id + ' dataset revision differs from design')
  assert(entry.tasks.every((task) => task.repository.revision === pack.dataset.taskRevision), pack.id + ' task revision differs from design')
  assert(spec.verification.verifierId === pack.expectedVerifier.id && spec.verification.verifierVersion === pack.expectedVerifier.version && spec.verification.officialRequired === pack.expectedVerifier.officialRequired, pack.id + ' expected verifier differs from design')
  assert(slice.dataset.officialBenchmark === pack.officialBenchmark, pack.id + ' officialBenchmark provenance differs from design')

  if (pack.id === 'swe-bench') {
    assert(pack.authority === 'pinned_official_harness_local_result', 'SWE-Bench authority must be pinned official harness local result')
    assert(/pinned official harness/iu.test(template.label) && /local run/iu.test(template.label), 'SWE-Bench label must state pinned official harness and local run')
    assert(pack.expectedVerifier.resultEvidenceLevel === 'official', 'SWE-Bench expected evidence must be official')
  } else {
    assert(pack.authority === 'compatible_local_pack', pack.id + ' must be a compatible local pack')
    assert(/(?:compatible )?local task pack/iu.test(template.label) && /non-official/iu.test(template.label), pack.id + ' label must state local-pack and non-official provenance')
    assert(pack.expectedVerifier.resultEvidenceLevel === 'native', pack.id + ' expected evidence must be native')
    assert(!/official/iu.test(pack.completionClaim), pack.id + ' completion claim must not imply official authority')
  }
}

const adapterFiles = {
  'terminal-bench': 'adapters/benchmarks/terminal-bench/src/index.ts',
  'program-bench': 'adapters/benchmarks/program-bench/src/index.ts',
  'swe-marathon': 'adapters/benchmarks/swe-marathon/src/index.ts',
}
for (const [id, path] of Object.entries(adapterFiles)) {
  const source = await readFile(resolve(root, path), 'utf8')
  assert(source.includes('compatible local task pack · non-official'), id + ' adapter lacks non-official compatible-local provenance')
  assert(source.includes('official: false'), id + ' adapter must reject official authority')
}

const completionClaimFiles = [
  'docs/evaluation/COMPATIBILITY.md',
  'docs/evaluation/benchmark-design-manifest.json',
  'docs/architecture/agent-evaluation-platform-refactor.md',
  'docs/architecture/agent-evaluation-platform-implementation-ledger.md',
]
for (const path of completionClaimFiles) {
  const source = await readFile(resolve(root, path), 'utf8')
  assert(!/official_calibration|one[- ](?:pair|case) official calibration|official-scored/iu.test(source), path + ' retains a non-SWE-Bench official completion claim')
}

process.stdout.write(JSON.stringify({ ok: true, packs: design.packs.length, agents: design.agents.length, modelExperimentsRun: 0 }) + '\n')

function validateComparisonPolicy(manifest) {
  const requiredCoordinates = ['taskIdsHash', 'datasetRevision', 'sliceManifestHash', 'verifierId', 'verifierVersion', 'sandboxProvider', 'imageDigest', 'modelId', 'modelRevision', 'inferenceParametersHash', 'toolPolicyHash', 'tokenBudget', 'timeBudgetMs', 'networkPolicyHash', 'repeats']
  assert(manifest.integrationMatrix?.inventoryRef === 'docs/evaluation/canonical-pack-inventory.json', 'integration matrix must reference canonical inventory')
  assert(manifest.controlledComparison?.rankingAllowedOnlyWhenCoordinatesEqual === true, 'ranking must require equal controlled coordinates')
  assert(equal(manifest.controlledComparison.requiredCoordinates, requiredCoordinates), 'controlled comparison coordinates are incomplete')
  assert(manifest.controlledComparison.missingCoordinatePolicy === 'unranked_integration_only', 'missing fair coordinates must prohibit ranking')
}
function validateCleanup(cleanup) {
  const required = ['schemaVersion', 'runId', 'trialId', 'agentVariantId', 'taskId', 'provider', 'sandboxId', 'destroyedAt', 'residue']
  assert(cleanup?.schemaVersion === 1 && cleanup.receiptRequired === true, 'cleanup receipt schema must be required')
  assert(equal(cleanup.requiredFields, required), 'cleanup receipt fields are incomplete')
  assert(Object.values(cleanup.residue ?? {}).every((value) => value === 0), 'cleanup residue targets must all be zero')
}
async function json(path) { return JSON.parse(await readFile(resolve(root, path), 'utf8')) }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function assert(condition, message) { if (!condition) throw new Error(message) }
