#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))

const caseIdParts = args.caseId.split(':')
if (caseIdParts.length !== 2) fail(`case id must look like split:profession__taskN, got ${args.caseId}`)
const split = caseIdParts[0]
const taskId = caseIdParts[1]
const match = taskId.match(/^(.*)__task(\d+)$/)
if (!match) fail(`case id task part must look like profession__taskN, got ${taskId}`)
const profession = match[1]
const taskName = `task${match[2]}`

const runRoot = resolve(args.runRoot)
const outputRoot = resolve(args.outputRoot)
const taskDir = join(outputRoot, profession, taskName)
await rm(taskDir, { recursive: true, force: true })
await mkdir(taskDir, { recursive: true })

const agentRoots = {
  'agent-runlab': join(runRoot, 'agent-runlab', args.caseId),
  'claude-code': join(runRoot, 'claude-code', args.caseId),
}

const firstCaseRoot = Object.values(agentRoots).find((path) => existsSync(path))
if (!firstCaseRoot) fail(`no agent case roots found for ${args.caseId} under ${runRoot}`)

await cp(join(firstCaseRoot, 'RUBRICS.json'), join(taskDir, 'RUBRICS.json'))
if (existsSync(join(firstCaseRoot, 'task_card.md'))) {
  await cp(join(firstCaseRoot, 'task_card.md'), join(taskDir, 'task_card.md'))
}

const taskFolder = join(taskDir, 'task_folder')
await mkdir(taskFolder, { recursive: true })
const refManifest = JSON.parse(await readFile(join(firstCaseRoot, 'reference-files.json'), 'utf8'))
for (const item of refManifest.downloaded ?? []) {
  const source = join(firstCaseRoot, 'workspace', item.local_path)
  if (existsSync(source)) await cp(source, join(taskFolder, basename(item.local_path)))
}

const manifest = {
  schema_version: 1,
  source_run_root: runRoot,
  case_id: args.caseId,
  judge_dataset_root: outputRoot,
  task_dir: taskDir,
  models: [],
}

for (const [agent, root] of Object.entries(agentRoots)) {
  if (!existsSync(root)) continue
  const modelName = args[agent === 'agent-runlab' ? 'agentModelName' : 'claudeModelName']
  const deliverablesDir = join(root, 'deliverables')
  if (!existsSync(deliverablesDir)) fail(`deliverables missing for ${agent}: ${deliverablesDir}`)
  const modelOutput = join(taskDir, 'model_output', modelName)
  await mkdir(dirname(modelOutput), { recursive: true })
  await rm(modelOutput, { recursive: true, force: true })
  await cp(deliverablesDir, modelOutput, { recursive: true })
  const files = await fileManifest(modelOutput)
  manifest.models.push({ agent, model_output_name: modelName, source_deliverables: deliverablesDir, files })
}

await writeFile(join(outputRoot, 'judge-dataset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(manifest, null, 2))

async function fileManifest(root) {
  const { readdir, stat } = await import('node:fs/promises')
  const out = []
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        const bytes = await readFile(path)
        out.push({
          path: path.slice(root.length).replace(/^\/+/, '').replaceAll('\\', '/'),
          size: (await stat(path)).size,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  await visit(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function parseArgs(argv) {
  const runRoot = value(argv, '--run-root')
  const caseId = value(argv, '--case-id')
  const outputRoot = value(argv, '--output-root')
  if (!runRoot) fail('missing --run-root')
  if (!caseId) fail('missing --case-id')
  if (!outputRoot) fail('missing --output-root')
  return {
    runRoot,
    caseId,
    outputRoot,
    agentModelName: value(argv, '--agent-model-name') ?? 'agent-runlab-sonnet-4-6',
    claudeModelName: value(argv, '--claude-model-name') ?? 'claude-code-sonnet-4-6',
  }
}

function value(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
