import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const outputRoot = resolve(root, 'deploy/evaluation')
const fixtureRoot = join(outputRoot, 'fixtures')
const trialImage = 'lxd-image.invalid/base'
const sweBenchImage = 'lxd-image.invalid/swe-bench'
const officialSweBenchImage = 'docker.io/swebench/sweb.eval.x86_64.astropy_1776_astropy-12907@sha256:f3f63bb87d581c0e7b47f900dd82165b71040e1758d3c29e915e2b18da9baf63'
const harnessRevision = 'f7bbbb2ccdf479001d6467c9e34af59e44a840f9'
const allowedDestinations = ['model-gateway.invalid:3000']
const credentialRefs = [{ referenceId: 'local-model-api-key', provider: 'openai', scope: ['model-inference'] }]
const definitions = [
  { id: 'terminal-bench', source: 'task-packs/terminal-bench-v1/release-ledger', taskId: 'release-ledger-reconciliation', title: 'Reconcile a release ledger with shell tools', promptFile: 'TASK.md', verifierId: 'terminal-bench-native', primary: 'reward', verification: terminalBenchVerification() },
  { id: 'program-bench', source: 'task-packs/program-bench-v1/greeting-cli', taskId: 'greeting-cli', title: 'Implement and compile a deterministic greeting CLI', promptFile: 'TASK.md', verifierId: 'program-bench-native', primary: 'compile_passed', verification: programBenchVerification() },
  { id: 'code-understanding', source: 'task-packs/code-understanding-v1/configuration-runtime-trace', taskId: 'configuration-runtime-trace', title: 'Localize a configuration-to-runtime dependency chain', promptFile: 'TASK.md', verifierId: 'code-understanding-native', primary: 'file_recall_at_k', protectedPaths: ['config', 'scripts', 'src', 'tests'], verification: codeUnderstandingVerification() },
  { id: 'memory-planning', source: 'task-packs/memory-planning-v1/release-handoff', taskId: 'release-handoff', title: 'Recover an isolated compacted handoff and execute its plan graph', promptFile: 'TASK.md', verifierId: 'memory-planning-native', primary: 'memory_recall', protectedPaths: ['incident', 'memory', 'scripts', 'tests'], verification: memoryPlanningVerification() },
  { id: 'fault-scenarios', source: 'task-packs/fault-scenarios-v1/config-schema-recovery', taskId: 'config-schema-recovery', title: 'Diagnose and recover a strict configuration schema failure', promptFile: 'INCIDENT.md', verifierId: 'fault-scenario-native', primary: 'recovered', faultScenarioIds: ['invalid-port-type-v1'], verification: faultVerification() },
  { id: 'sdlc-journey', source: 'task-packs/sdlc-journey-v1/service-release', taskId: 'service-release-v2', title: 'Build, package, deploy, verify, and roll back service release v2', promptFile: 'ISSUE.md', verifierId: 'sdlc-journey-native', primary: 'journey_completed', verification: sdlcVerification() },
]

await mkdir(fixtureRoot, { recursive: true, mode: 0o700 })
const prepared = []
for (const definition of definitions) prepared.push({ definition, ...(await prepareTask(definition)) })
prepared.push({ definition: marathonDefinition(), ...(await prepareMarathon()) })
const smoke = await smokeCatalog()
const entries = [smoke.entry]
const templates = [smoke.template]
for (const item of prepared) {
  const task = resolvedTask(item)
  const taskIds = [task.taskId]
  const taskIdsHash = sha(canonical(taskIds))
  const datasetManifestHash = sha(canonical({ taskPackId: task.taskPackId, version: '1.0.0', fixtures: [{ taskId: task.taskId, fixtureManifestHash: task.fixtureManifestHash }] }))
  const sliceManifestHash = sha(canonical({ schemaVersion: 1, datasetManifestHash, selectionKind: 'full', taskIds }))
  entries.push({ sliceManifestHash, tasks: [task] })
  templates.push(templateFor({ definition: item.definition, task, taskIdsHash, datasetManifestHash, sliceManifestHash }))
}
const sweBench = await sweBenchCatalog()
entries.push(sweBench.entry)
templates.push(sweBench.template)
await writeFile(join(outputRoot, 'catalog.json'), JSON.stringify(entries, null, 2) + '\n')
await writeFile(join(outputRoot, 'run-templates.json'), JSON.stringify(templates, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ok: true, catalogSlices: entries.length, templates: templates.length, fixtures: prepared.length + 1 }) + '\n')

async function smokeCatalog() {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-deploy-smoke-'))
  const repository = join(temporary, 'compose-smoke-task')
  try {
    await mkdir(repository, { recursive: true }); await writeFile(join(repository, 'README.md'), '# Deterministic evaluation fixture\n')
    await initializeRepository(repository)
    const revision = (await run('git', ['rev-parse', 'HEAD'], repository)).stdout.trim()
    const archiveRef = 'fixtures/compose-smoke.tar', archive = join(outputRoot, archiveRef)
    await reproducibleTar(repository, archive)
    const archiveSha256 = sha(await readFile(archive)); const taskId = 'compose-smoke-task'; const fixtureManifestHash = sha(canonical({ archiveSha256, revision, taskId }))
    const task = { schemaVersion: 1, taskId, taskPackId: 'custom-task-pack', taskPackVersion: '1.0.0', title: 'Deterministic Web-controlled Worker smoke', prompt: 'Run the declared deterministic command and preserve canonical evaluation evidence.', repository: { kind: 'artifact', archiveRef, archiveSha256, revision }, fixtureManifestHash, faultScenarioIds: [], verification: [{ stepId: 'canonical-smoke', argv: ['sh','-ceu',"grep -F 'web-controlled run accepted' README.md"], cwd: '.', timeoutMs: 10000, requiredExitCode: 0, nativeMetric: 'passed' }], analysis: { constraints: [{ id: 'canonical-smoke', kind: 'must', sourceRef: 'task#canonical-smoke', verifierId: 'custom-task-verifier', verifierVersion: '1.0.0', verifierMetric: 'passed' }], protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'local standalone deployment acceptance' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:compose-smoke-task'] }, publication: { artifact: { status: 'granted', basis: 'local standalone deployment acceptance' }, report: { status: 'granted', basis: 'local standalone deployment acceptance' }, leaderboard: { status: 'granted', basis: 'local standalone deployment acceptance' }, redistribution: { status: 'granted', basis: 'MIT' } } } }
    const taskIds=[taskId], taskIdsHash=sha(canonical(taskIds)), datasetManifestHash=sha(canonical({ taskPackId:'custom-task-pack',version:'1.0.0',fixtures:[{taskId,fixtureManifestHash}] })), sliceManifestHash=sha(canonical({schemaVersion:1,datasetManifestHash,selectionKind:'full',taskIds}))
    const commandConfig={argv:['sh','-ceu','printf \"# Deterministic evaluation fixture\\n\\nweb-controlled run accepted\\n\" > README.md; printf \"web evaluation worker accepted\\n\"']}
    const spec={ schemaVersion:1,runId:'template-custom-command-smoke',taskPack:{id:'custom-task-pack',version:'1.0.0',evaluatedSlice:{sliceId:'compose-smoke-full',dataset:{datasetId:'compose-smoke',displayName:'Compose Smoke',version:'1.0.0',sourceRevision:datasetManifestHash,manifestHash:datasetManifestHash,taskIdsHash,totalItems:1,officialBenchmark:false,policy:catalogPolicy('local standalone deployment acceptance','dataset:compose-smoke')},selectionKind:'full',selectionSpec:{kind:'full',taskIdsHash},selectedItems:1,coverageRatio:1,taskIdsManifestRef:'catalog/compose-smoke.json',sliceManifestHash},policy:catalogPolicy('local standalone deployment acceptance','task-pack:custom-task-pack')},agents:[{variantId:'custom-command-smoke',backendId:'custom-command',agentVersion:'1.0.0',model:{modelId:'deterministic-command'},configHash:sha(canonical(commandConfig)),config:commandConfig,credentialRefs:[]}],execution:{repeats:1,priority:0,maxConcurrency:1,maxConcurrencyPerBackend:1,maxConcurrencyPerProvider:1,leaseMs:30000,timeoutMs:30000,inactivityTimeoutMs:10000,retryPolicy:{maxAttempts:1,retryableCategories:[],backoffMs:0}},sandbox:{provider:'docker',imageDigest:'node@sha256:7725a5c2c83eed1d36258c66efae14b1ceccd021db9ed1d9559d3335ed3d68ed',readOnlyBase:true,ephemeralOverlay:true,resources:{cpu:1,memoryMb:256,diskMb:256,pids:64},network:{mode:'denied',allowedDestinations:[]},artifactAllowlist:['{taskPackId}/{trialId}/native-result.json']},verification:{verifierId:'custom-task-verifier',verifierVersion:'1.0.0',officialRequired:false,timeoutMs:30000,configHash:sha(canonical(task.verification))},analysis:{detectorIds:['instruction-drift'],repeatsRequired:1,configHash:sha(canonical({detectorSet:'smoke-v1'}))},createdAt:'2026-08-04T00:00:00.000Z'}
    return {entry:{sliceManifestHash,tasks:[task]},template:{schemaVersion:1,templateId:'custom-command-smoke',label:'Local deterministic smoke',description:'Credential-free Docker smoke for Web create/start/control/monitoring. It is not a ranked model benchmark.',kind:'smoke',recommended:false,builder:{taskIds,artifactAllowlistPathTemplates:['{taskPackId}/{trialId}/native-result.json']},spec}}
  } finally { await rm(temporary,{recursive:true,force:true}) }
}

async function prepareTask(definition) {
  const source = resolve(root, definition.source)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-deploy-task-'))
  const repository = join(temporary, definition.taskId)
  try {
    await run('cp', ['-a', source + '/.', repository])
    await initializeRepository(repository)
    const revision = (await run('git', ['rev-parse', 'HEAD'], repository)).stdout.trim()
    const archiveRef = 'fixtures/' + definition.taskId + '.tar'
    const archive = join(outputRoot, archiveRef)
    await reproducibleTar(repository, archive)
    const body = await readFile(archive)
    const archiveSha256 = sha(body)
    return { archiveRef, archiveSha256, revision, prompt: await readFile(join(source, definition.promptFile), 'utf8'), fixtureManifestHash: sha(canonical({ archiveSha256, revision, taskId: definition.taskId })) }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

async function prepareMarathon() {
  const definition = marathonDefinition()
  const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-deploy-marathon-'))
  const repository = join(temporary, definition.taskId)
  try {
    await mkdir(join(repository, 'outcomes'), { recursive: true })
    await writeFile(join(repository, 'TASK.md'), '# Reconcile a synthetic three-task release marathon\n\nInspect the declared outcomes and preserve the complete release evidence.\n')
    await writeFile(join(repository, 'outcomes/task-a'), '1\n'); await writeFile(join(repository, 'outcomes/task-b'), '0\n'); await writeFile(join(repository, 'outcomes/task-c'), '1\n')
    await writeFile(join(repository, 'package.json'), '{"name":"release-marathon","private":true}\n')
    await initializeRepository(repository)
    const revision = (await run('git', ['rev-parse', 'HEAD'], repository)).stdout.trim()
    const archiveRef = 'fixtures/' + definition.taskId + '.tar'
    const archive = join(outputRoot, archiveRef)
    await reproducibleTar(repository, archive)
    const archiveSha256 = sha(await readFile(archive))
    return { archiveRef, archiveSha256, revision, prompt: await readFile(join(repository, 'TASK.md'), 'utf8'), fixtureManifestHash: sha(canonical({ archiveSha256, revision, taskId: definition.taskId })) }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

async function initializeRepository(repository) {
  await run('git', ['init', '-q', '-b', 'main'], repository); await run('git', ['config', 'user.name', 'Agent Evaluation Fixture'], repository); await run('git', ['config', 'user.email', 'evaluation@localhost'], repository); await run('git', ['add', '.'], repository)
  await run('git', ['commit', '-qm', 'immutable task fixture'], repository, { GIT_AUTHOR_DATE: '2026-08-03T00:00:00Z', GIT_COMMITTER_DATE: '2026-08-03T00:00:00Z' })
  const index = join(repository, '..', '.deterministic-index')
  await run('git', ['read-tree', 'HEAD'], repository, { GIT_INDEX_FILE: index }); await run('mv', [index, join(repository, '.git', 'index')], repository)
}
async function reproducibleTar(repository, archive) { await run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', repository, '.']) }

function resolvedTask(item) {
  const d = item.definition
  return { schemaVersion: 1, taskId: d.taskId, taskPackId: d.id, taskPackVersion: '1.0.0', title: d.title, prompt: item.prompt, repository: { kind: 'artifact', archiveRef: item.archiveRef, archiveSha256: item.archiveSha256, revision: item.revision }, requiredSandboxImageDigest: trialImage, fixtureManifestHash: item.fixtureManifestHash, faultScenarioIds: d.faultScenarioIds ?? [], verification: d.verification, analysis: { constraints: d.verification.map((step) => ({ id: step.stepId, kind: 'must', sourceRef: 'task#' + step.stepId, verifierId: d.verifierId, verifierVersion: '1.0.0', verifierMetric: step.nativeMetric ?? step.stepId })), protectedPaths: d.protectedPaths ?? ['fixture'], hiddenVerifierPaths: [] }, lxdInitMode: 'keepalive', policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'public synthetic evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:deployment-catalog'] }, publication: { artifact: { status: 'granted', basis: 'public synthetic evaluation' }, report: { status: 'granted', basis: 'public synthetic evaluation' }, leaderboard: { status: 'granted', basis: 'public synthetic evaluation' }, redistribution: { status: 'granted', basis: 'MIT' } } } }
}

function templateFor({ definition: d, task, taskIdsHash, datasetManifestHash, sliceManifestHash }) {
  const agents = agentVariants()
  const spec = baseSpec(d.id, d.taskId, taskIdsHash, datasetManifestHash, sliceManifestHash, agents, trialImage, d.verifierId, '1.0.0', false, sha(canonical(d.verification)))
  return { schemaVersion: 1, templateId: d.id + '-real', label: label(d.id), description: 'Run the non-official compatible/local task pack against its immutable one-task slice in a fresh pinned LXD sandbox. Results are not official benchmark results.', kind: 'benchmark', recommended: d.id === 'terminal-bench', builder: { taskIds: [d.taskId], artifactAllowlistPathTemplates: ['{taskPackId}/{trialId}/native-result.json'] }, spec }
}

function baseSpec(taskPackId, taskId, taskIdsHash, datasetManifestHash, sliceManifestHash, agents, imageDigest, verifierId, verifierVersion, officialRequired, configHash) {
  return { schemaVersion: 1, runId: 'template-' + taskPackId + '-real', taskPack: { id: taskPackId, version: '1.0.0', evaluatedSlice: { sliceId: taskPackId + '-production-v1', dataset: { datasetId: taskPackId + '-v1', displayName: label(taskPackId), version: '1.0.0', sourceRevision: datasetManifestHash, manifestHash: datasetManifestHash, taskIdsHash, totalItems: 1, officialBenchmark: officialRequired, policy: catalogPolicy(officialRequired ? 'SWE-Bench benchmark evaluation' : 'public synthetic evaluation', 'dataset:' + taskPackId) }, selectionKind: 'full', selectionSpec: { kind: 'full', taskIdsHash }, selectedItems: 1, coverageRatio: 1, taskIdsManifestRef: 'catalog/' + taskPackId + '.json', sliceManifestHash }, policy: catalogPolicy(officialRequired ? 'SWE-Bench benchmark evaluation' : 'public synthetic evaluation', 'task-pack:' + taskPackId) }, agents, execution: { repeats: 1, priority: 0, maxConcurrency: 1, maxConcurrencyPerBackend: 1, maxConcurrencyPerProvider: 1, leaseMs: 30000, timeoutMs: taskPackId === 'swe-bench' ? 1800000 : 900000, inactivityTimeoutMs: 180000, retryPolicy: { maxAttempts: 1, retryableCategories: [], backoffMs: 0 } }, sandbox: { provider: 'lxd-container', imageDigest, readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 2, memoryMb: 4096, diskMb: 8192, pids: 512 }, network: { mode: 'allowlist', allowedDestinations }, artifactAllowlist: ['runlab-session.jsonl', 'runlab-native.tar'] }, verification: { verifierId, verifierVersion, officialRequired, timeoutMs: taskPackId === 'swe-bench' ? 1800000 : 120000, configHash }, analysis: { detectorIds: ['instruction-drift', 'context-forgetting', 'test-gaming', 'tool-recovery', 'planning-execution'], repeatsRequired: 1, configHash: sha(canonical({ detectorSet: 'required-v1' })) }, createdAt: '2026-08-04T00:00:00.000Z' }
}

function agentVariants() {
  const values = [
    { variantId: 'agent-runlab', backendId: 'agent-runlab', model: { provider: 'openai', modelId: 'gpt-5.6-sol' }, config: { provider: 'openai', baseUrl: 'http://model-gateway.invalid:3000/v1' }, credentialRefs },
    { variantId: 'claude-code', backendId: 'claude-code', model: { provider: 'anthropic', modelId: 'claude-opus-4.8' }, config: { baseUrl: 'http://model-gateway.invalid:3000' }, credentialRefs: credentialRefs.map((reference) => ({ ...reference, provider: 'anthropic' })) },
    { variantId: 'codex', backendId: 'codex', model: { provider: 'openai', modelId: 'gpt-5.6-sol' }, config: { baseUrl: 'http://model-gateway.invalid:3000/v1', transport: 'app-server', reasoningEffort: 'medium' }, credentialRefs },
  ]
  return values.map((value) => ({ ...value, agentVersion: '0.0.0', configHash: sha(canonical(value.config)) }))
}

async function sweBenchCatalog() {
  const record = await fetchSweBenchRecord()
  const repositoryManifestHash = sha(canonical({ repo: record.repo, baseCommit: record.base_commit, officialImage: officialSweBenchImage, trialImage: sweBenchImage }))
  const benchmarkInput = { schemaVersion: 1, benchmarkId: 'swe-bench', datasetId: 'swe-bench-verified', datasetVersion: 'verified-1', split: 'test', harnessRevision, officialInstanceImageDigest: officialSweBenchImage, trialSandboxImageDigest: sweBenchImage, officialRecord: record, testTimeoutSeconds: 1800, namespace: 'swebench', instanceImageTag: 'latest', envImageTag: 'latest' }
  const task = { schemaVersion: 1, taskId: record.instance_id, taskPackId: 'swe-bench', taskPackVersion: 'verified-1', title: record.repo + ' / ' + record.instance_id, prompt: record.problem_statement, repository: { kind: 'git', url: 'https://github.com/' + record.repo + '.git', revision: record.base_commit, repositoryManifestHash }, requiredSandboxImageDigest: sweBenchImage, fixtureManifestHash: repositoryManifestHash, faultScenarioIds: [], lxdInitMode: 'keepalive', verification: [{ stepId: 'swe-bench-official', argv: ['agent-eval-swe-bench-grade'], cwd: '.', timeoutMs: 1800000, requiredExitCode: 0, nativeMetric: 'resolved' }], analysis: { constraints: [{ id: 'swe-bench-resolved', kind: 'evidence', sourceRef: 'benchmark#resolved', verifierId: 'swe-bench-official', verifierVersion: harnessRevision, verifierMetric: 'resolved' }], protectedPaths: [], hiddenVerifierPaths: [] }, benchmarkInput, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'SWE-Bench benchmark evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['dataset:swe-bench-verified'] }, publication: { artifact: { status: 'granted', basis: 'SWE-Bench benchmark evaluation' }, report: { status: 'granted', basis: 'SWE-Bench benchmark evaluation' }, leaderboard: { status: 'granted', basis: 'SWE-Bench benchmark evaluation' }, redistribution: { status: 'granted', basis: 'MIT' } } } }
  const taskIds = [task.taskId], taskIdsHash = sha(canonical(taskIds))
  const datasetManifestHash = sha(canonical({ datasetId: 'swe-bench-verified', version: 'verified-1', split: 'test', totalItems: 500, selectedRecordHash: sha(canonical(record)), source: 'https://datasets-server.huggingface.co/filter' }))
  const sliceManifestHash = sha(canonical({ schemaVersion: 1, datasetManifestHash, selectionKind: 'explicit_ids', taskIds, taskIdsHash }))
  const config = { harnessRevision, officialImage: officialSweBenchImage, testTimeoutSeconds: 1800 }
  const spec = baseSpec('swe-bench', task.taskId, taskIdsHash, datasetManifestHash, sliceManifestHash, agentVariants(), sweBenchImage, 'swe-bench-official', harnessRevision, true, sha(canonical(config)))
  spec.taskPack.version = 'verified-1'; spec.taskPack.evaluatedSlice.selectionKind = 'explicit_ids'; spec.taskPack.evaluatedSlice.selectionSpec = { kind: 'explicit_ids', taskIdsHash }; spec.taskPack.evaluatedSlice.coverageRatio = 1 / 500; spec.taskPack.evaluatedSlice.dataset.totalItems = 500; spec.taskPack.evaluatedSlice.dataset.version = 'verified-1'; spec.taskPack.evaluatedSlice.dataset.datasetId = 'swe-bench-verified'; spec.taskPack.evaluatedSlice.dataset.displayName = 'SWE-Bench Verified'; spec.taskPack.evaluatedSlice.taskIdsManifestRef = 'catalog/swe-bench-astropy-12907.json'
  return { entry: { sliceManifestHash, tasks: [task] }, template: { schemaVersion: 1, templateId: 'swe-bench-astropy-12907', label: 'SWE-Bench Verified · pinned official harness · local run · Astropy 12907', description: 'Run the pinned official SWE-Bench harness locally for astropy__astropy-12907 in the pinned accepted LXD trial image.', kind: 'benchmark', recommended: false, builder: { taskIds, artifactAllowlistPathTemplates: ['swe-bench/{trialId}/official-result.json'] }, spec } }
}

function catalogPolicy(basis, sourceRef) {
  return { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: [sourceRef] }, publication: { artifact: { status: 'granted', basis }, report: { status: 'granted', basis }, leaderboard: { status: 'granted', basis }, redistribution: { status: 'granted', basis: 'MIT' } } }
}

async function fetchSweBenchRecord() {
  const url = new URL('https://datasets-server.huggingface.co/filter'); url.searchParams.set('dataset', 'princeton-nlp/SWE-bench_Verified'); url.searchParams.set('config', 'default'); url.searchParams.set('split', 'test'); url.searchParams.set('where', '"instance_id"=\'astropy__astropy-12907\'')
  const response = await fetch(url); if (!response.ok) throw new Error('SWE-Bench record fetch failed: HTTP ' + response.status)
  const body = await response.json(); if (!Array.isArray(body.rows) || body.rows.length !== 1) throw new Error('SWE-Bench record fetch returned an unexpected row count')
  return body.rows[0].row
}

function marathonDefinition() { const script = 'total=$(find outcomes -type f | wc -l | tr -d " "); resolved=$(grep -l "^1$" outcomes/* | wc -l | tr -d " "); test "$total" -eq 3; test "$resolved" -eq 2; printf "{\\"metrics\\":{\\"resolved_tasks\\":%s,\\"total_tasks\\":%s}}\\n" "$resolved" "$total"'; return { id: 'swe-marathon', taskId: 'public-release-marathon', title: 'Reconcile a synthetic three-task release marathon', verifierId: 'swe-marathon-native', primary: 'resolved_tasks', verification: [{ stepId: 'native-resolution', nativeMetric: 'resolved_tasks', argv: ['sh', '-ceu', script], cwd: '.', timeoutMs: 30000, requiredExitCode: 0 }] } }
function terminalBenchVerification() { return [{ stepId: 'native-reward', nativeMetric: 'reward', argv: ['sh', '-ceu', 'test ! -e fixture/expected-answer.txt; test "$(tr -d \'[:space:]\' < answer.txt)" = 117; git diff --exit-code HEAD -- fixture; printf \'%s\\n\' \'{"metrics":{"reward":1}}\''], cwd: '.', timeoutMs: 120000, requiredExitCode: 0 }] }
function programBenchVerification() { return [{ stepId: 'submission-contract', nativeMetric: 'submission_contract', argv: ['sh', '-ceu', 'test -s program.mjs; test -x compile.sh; count=$(find . -maxdepth 1 -type f -name \'program.*\' | wc -l | tr -d \' \'); test "$count" -eq 1; printf \'{"metrics":{"contract_ok":true,"implementation_file_count":%s}}\\n\' "$count"'], cwd: '.', timeoutMs: 120000, requiredExitCode: 0 }, { stepId: 'compile', nativeMetric: 'compile_passed', argv: ['sh', '-ceu', './compile.sh; test -x executable; printf \'%s\\n\' \'{"metrics":{"compile_passed":true}}\''], cwd: '.', timeoutMs: 120000, requiredExitCode: 0 }, { stepId: 'tests', nativeMetric: 'tests_passed', argv: ['sh', '-ceu', 'test "$(./executable fixture)" = \'hello fixture\'; test "$(./executable \'two words\')" = \'hello two words\'; if ./executable >out 2>error; then exit 1; else grep -F \'usage:\' error; fi; git diff --exit-code HEAD -- fixture; printf \'%s\\n\' \'{"metrics":{"tests_passed":true}}\''], cwd: '.', timeoutMs: 120000, requiredExitCode: 0 }] }
function faultVerification() { return ['fault_injected','fault_observed','recovery_action_grounded','service_recovered','success_control_passed'].map((name, index) => metric(name, ["git show HEAD:config/service.json | grep -F '\"port\": \"18110\"'; grep -F CONFIG_SCHEMA_INVALID fixture/incident.log; git diff --exit-code HEAD -- fixture src", 'test -s evidence/recovery.md; grep -F CONFIG_SCHEMA_INVALID evidence/recovery.md; grep -F config/service.json evidence/recovery.md', 'node -e \'const c=require("./config/service.json");if(!Number.isInteger(c.port)||c.port!==18110)process.exit(1)\'; git diff --exit-code HEAD -- fixture src', 'npm run check', 'npm test'][index])) }
function sdlcVerification() { return ['investigation_passed','implementation_verified','tests_passed','build_passed','package_created','deploy_succeeded','health_verified','rollback_verified'].map((name, index) => metric(name, ['test -s evidence/investigation.md', 'node -e \'import("./src/service.mjs").then(m=>{if(m.releaseVersion!=="v2")process.exit(1)})\'', 'npm test', 'npm run build', 'npm run package; test -s release/service.tar', 'SERVICE_PORT=18080 node dist/service.mjs >/tmp/sdlc-service.log 2>&1 & echo $! > deploy.pid; sleep 1; kill -0 "$(cat deploy.pid)"', 'node -e \'fetch("http://127.0.0.1:18080/health").then(r=>r.json()).then(h=>{if(h.status!=="ok")process.exit(1)})\'', 'kill "$(cat deploy.pid)"; wait "$(cat deploy.pid)" 2>/dev/null || true'][index])) }
function codeUnderstandingVerification() { const oracle = { repositoryFiles: ['TASK.md','package.json','localization.json','config/defaults.json','src/admin-report.mjs','src/audit-log.mjs','src/cli.mjs','src/config.mjs','src/formatter.mjs','src/runtime.mjs','scripts/validate-submission.mjs','tests/runtime.test.mjs'], relevantFiles: ['config/defaults.json','src/cli.mjs','src/config.mjs','src/formatter.mjs','src/runtime.mjs'], relevantSymbols: ['config/defaults.json#greetingPrefix','src/cli.mjs#main','src/config.mjs#loadConfig','src/formatter.mjs#formatGreeting','src/runtime.mjs#createGreeting'], dependencyEdges: [['src/cli.mjs#main','src/config.mjs#loadConfig'],['src/cli.mjs#main','src/runtime.mjs#createGreeting'],['src/config.mjs#loadConfig','config/defaults.json#greetingPrefix'],['src/runtime.mjs#createGreeting','src/formatter.mjs#formatGreeting']] }; const script = 'npm test; git diff --exit-code HEAD -- TASK.md package.json config scripts src tests; submission=$(node scripts/validate-submission.mjs); node -e \'const submission=JSON.parse(process.argv[1]);const oracle=JSON.parse(process.argv[2]);console.log(JSON.stringify({metrics:{code_understanding_observation:JSON.stringify({k:submission.k,rankedFiles:submission.rankedFiles,rankedSymbols:submission.rankedSymbols,readSequence:[],predictedDependencyEdges:submission.predictedDependencyEdges,oracle})}}))\' "$submission" \'' + JSON.stringify(oracle) + '\''; return [{ stepId: 'localization-observation', nativeMetric: 'code_understanding_observation', argv: ['sh','-ceu',script], cwd: '.', timeoutMs: 120000, requiredExitCode: 0 }] }
function memoryPlanningVerification() { const oracle = { activeFacts:[{factId:'owner',value:'release-ops'},{factId:'region',value:'ap-southeast-1'},{factId:'format',value:'tar'},{factId:'channel',value:'stable'}], correctedFactIds:['region'],preCompactionFactIds:['owner','channel'],longTermFactIds:['owner','format','channel'],staleValues:['us-east-1'],deletedValues:['legacy-token-9'],foreignValues:['green-team','eu-west-1','zip'],expectedPlanNodes:['recall','update','test','policy','package','verify'],expectedDependencyEdges:[['recall','update'],['update','test'],['update','policy'],['test','package'],['policy','package'],['package','verify']],expectedParallelPairs:[['test','policy']],expectedReplans:[{triggerId:'path-drift',supersededStepId:'legacy-deploy',replacementStepId:'verify'}] }; const script = 'npm test; git diff --exit-code HEAD -- TASK.md package.json incident memory scripts tests; submission=$(node scripts/validate-submission.mjs); node -e \'const submission=JSON.parse(process.argv[1]);const oracle=JSON.parse(process.argv[2]);console.log(JSON.stringify({metrics:{memory_planning_observation:JSON.stringify({submission,oracle,observedExecutionOrder:[]})}}))\' "$submission" \'' + JSON.stringify(oracle) + '\''; return [{ stepId: 'memory-planning-observation', nativeMetric: 'memory_planning_observation', argv: ['sh','-ceu',script], cwd: '.', timeoutMs: 120000, requiredExitCode: 0 }] }
function metric(name, script) { return { stepId: name, nativeMetric: name, argv: ['sh','-ceu',script + '; printf \'%s\\n\' \'{"metrics":{"' + name + '":true}}\''], cwd: '.', timeoutMs: 120000, requiredExitCode: 0 } }
function label(id) { return ({ 'terminal-bench':'Terminal-Bench-compatible local task pack · non-official', 'program-bench':'ProgramBench-compatible local task pack · non-official', 'code-understanding':'Code Understanding local task pack · non-official', 'memory-planning':'Memory & Planning local task pack · non-official', 'fault-scenarios':'Fault Scenarios local task pack · non-official', 'sdlc-journey':'SDLC local task pack · non-official', 'swe-marathon':'SWE-Marathon-compatible local task pack · non-official', 'swe-bench':'SWE-Bench Verified · pinned official harness · local run' })[id] ?? id }
function canonical(value) { if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'; return JSON.stringify(value) }
function sha(value) { return createHash('sha256').update(value).digest('hex') }
async function run(binary, args, cwd, env = {}) { return await runFile(binary, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 }) }
