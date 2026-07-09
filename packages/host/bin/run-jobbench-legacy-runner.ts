#!/usr/bin/env tsx
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { createRuntimeLogger } from '../src/logger.js'
import { defaultBenchmarkEnvPath, loadAnthropicCliDefaults, loadEnvFile, requireAnthropicBaseUrl } from '../src/runtime-config.js'

type AgentName = 'agent-runlab' | 'claude-code'

type Args = {
  legacy-runnerDir: string
  split: 'easy' | 'main'
  selectedCasesPath: string
  runId: string
  agents: readonly AgentName[]
  model: string
  baseUrl: string
  baseUrlSource: 'cli' | 'env' | 'env-file' | 'claude-settings'
  smallFastModel: string
  timeoutMs: number
  maxTurns: number
  maxAgentRuns?: number
  stopAfterErrors?: number
  judgeModel: string
  judgeProvider: 'anthropic' | 'openai'
  judgeBaseUrl?: string
  seed: number
  limit: number
  offset: number
  caseIds: readonly string[]
  prepareSubset: boolean
  downloadReferenceFiles: boolean
  runJudge: boolean
  dryRun: boolean
}

type JobBenchCase = {
  benchmark: 'job-bench'
  instance_id: string
  split: 'easy' | 'main'
  occupation: string
  task_num: number
  prompt: string
  reference_files: readonly string[]
  reference_file_urls: readonly string[]
  reference_file_hf_uris: readonly string[]
  rubric_json: string
  task_card: string
}

type InstanceResult = {
  benchmark: 'job-bench'
  instance_id: string
  split: 'easy' | 'main'
  agent: AgentName
  model: string
  status: 'prepared' | 'submitted' | 'scored' | 'not_run' | 'error'
  score: number
  official: boolean
  scorer: string
  judge_model: string
  error_type: string | null
  artifact_refs: string[]
}

type ReferenceDownload = {
  source_path: string
  source_url: string
  hf_uri: string
  local_path: string
  sha256: string
  size: number
}

type DeliverableManifest = {
  schema_version: 1
  workspace_root: string
  files: Array<{ path: string; size: number; sha256: string }>
}

const logger = createRuntimeLogger('jobbench-legacy-runner')
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const root = join(args.legacy-runnerDir, 'artifacts', 'job-bench')
  await mkdir(root, { recursive: true })

  if (args.prepareSubset || !existsSync(args.selectedCasesPath)) {
    const allCases = await fetchJobBenchCases(args.split)
    const selected = selectDeterministicSubset(allCases, args)
    await writeSelectedCases(args, selected)
  }

  const selectedCases = selectRunCases(await readJsonl<JobBenchCase>(args.selectedCasesPath), args)
  const runRoot = join(root, args.runId)
  await mkdir(runRoot, { recursive: true })

  if (args.runJudge) {
    throw new Error('JobBench scoring must use the official JobBench eval/run_judge.sh path. Prepare a native judge dataset with scripts/eval/benchmarks/jobbench/prepare-jobbench-judge-dataset.mjs, run the official judge, then validate the result with scripts/eval/benchmarks/jobbench/validate-jobbench-judge-result.mjs.')
  }

  const results: InstanceResult[] = []
  let stopReason: string | null = null
  caseLoop:
  for (const item of selectedCases) {
    for (const agent of args.agents) {
      if (stopReason) break caseLoop
      const caseRoot = join(runRoot, agent, item.instance_id)
      const workspaceRoot = join(caseRoot, 'workspace')
      const deliverablesRoot = join(caseRoot, 'deliverables')
      await mkdir(workspaceRoot, { recursive: true })
      await mkdir(deliverablesRoot, { recursive: true })
      const promptPath = join(caseRoot, 'prompt.txt')
      const responsePath = join(caseRoot, 'response.txt')
      const rubricPath = join(caseRoot, 'RUBRICS.json')
      const taskCardPath = join(caseRoot, 'task_card.md')
      const refManifestPath = join(caseRoot, 'reference-files.json')
      const deliverablesManifestPath = join(caseRoot, 'deliverables-manifest.json')
      const judgePromptPath = join(caseRoot, 'judge-prompt.txt')
      const judgeResponsePath = join(caseRoot, 'judge-response.txt')
      const resultPath = join(caseRoot, 'result.json')
      await rm(workspaceRoot, { recursive: true, force: true })
      await mkdir(workspaceRoot, { recursive: true })
      await writeFile(promptPath, buildPrompt(item), 'utf8')
      await writeFile(rubricPath, `${item.rubric_json.trim()}\n`, 'utf8')
      await writeFile(taskCardPath, `${item.task_card.trim()}\n`, 'utf8')
      let downloadedReferences: ReferenceDownload[] = []
      if (!args.dryRun || args.downloadReferenceFiles) {
        downloadedReferences = await downloadReferenceFiles(item, workspaceRoot)
      }
      await writeFile(refManifestPath, `${JSON.stringify({
        schema_version: 1,
        split: item.split,
        instance_id: item.instance_id,
        reference_files: item.reference_files,
        reference_file_urls: item.reference_file_urls,
        reference_file_hf_uris: item.reference_file_hf_uris,
        downloaded: downloadedReferences,
      }, null, 2)}\n`, 'utf8')
      const artifactRefs = [
        relativeToLegacy Runner(args.legacy-runnerDir, promptPath),
        relativeToLegacy Runner(args.legacy-runnerDir, responsePath),
        relativeToLegacy Runner(args.legacy-runnerDir, rubricPath),
        relativeToLegacy Runner(args.legacy-runnerDir, taskCardPath),
        relativeToLegacy Runner(args.legacy-runnerDir, refManifestPath),
        relativeToLegacy Runner(args.legacy-runnerDir, deliverablesManifestPath),
      ]
      let status: InstanceResult['status'] = args.dryRun ? 'prepared' : 'submitted'
      let score = 0
      let official = false
      let scorer = args.runJudge ? 'jobbench.rubric-judge.pending' : 'jobbench.rubric-judge.not_run'
      let errorType: string | null = null

      if (!args.dryRun) {
        try {
          await runAgent(agent, args, promptPath, responsePath, workspaceRoot, caseRoot)
          const deliverables = await collectDeliverables(workspaceRoot, deliverablesRoot)
          await writeFile(deliverablesManifestPath, `${JSON.stringify(deliverables, null, 2)}\n`, 'utf8')
        } catch (err: unknown) {
          status = 'error'
          score = 0
          errorType = err instanceof Error ? err.message : String(err)
          await writeFile(join(caseRoot, 'error.txt'), `${errorType}\n`, 'utf8')
          artifactRefs.push(relativeToLegacy Runner(args.legacy-runnerDir, join(caseRoot, 'error.txt')))
        }
      } else {
        await writeFile(deliverablesManifestPath, `${JSON.stringify({ schema_version: 1, workspace_root: relativeToLegacy Runner(args.legacy-runnerDir, workspaceRoot), files: [] }, null, 2)}\n`, 'utf8')
      }
      const result: InstanceResult = {
        benchmark: 'job-bench',
        instance_id: item.instance_id,
        split: item.split,
        agent,
        model: args.model,
        status,
        score,
        official,
        scorer,
        judge_model: args.judgeModel,
        error_type: errorType,
        artifact_refs: artifactRefs,
      }
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      results.push(result)
      stopReason = runStopReason(args, results, selectedCases.length * args.agents.length)
      if (stopReason) break caseLoop
    }
  }

  await writeOutputs(args, runRoot, selectedCases, results, stopReason)
}

function buildPrompt(item: JobBenchCase): string {
  return `${item.prompt.trim()}

Work in the current directory only. The local reference files named above are available in this directory. Save the final requested documents and any supporting tables or figures under a top-level deliverables/ directory before your final response. Do not use files outside this workspace or prior benchmark artifacts.`
}

async function downloadReferenceFiles(item: JobBenchCase, workspaceRoot: string): Promise<ReferenceDownload[]> {
  const out: ReferenceDownload[] = []
  for (let i = 0; i < item.reference_file_urls.length; i++) {
    const url = item.reference_file_urls[i]!
    const sourcePath = item.reference_files[i] ?? url
    const localPath = join(workspaceRoot, basename(sourcePath))
    const res = await fetch(url)
    if (!res.ok) throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    await writeFile(localPath, bytes)
    out.push({
      source_path: sourcePath,
      source_url: url,
      hf_uri: item.reference_file_hf_uris[i] ?? '',
      local_path: basename(localPath),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    })
  }
  return out
}

async function runAgent(
  agent: AgentName,
  args: Args,
  promptPath: string,
  responsePath: string,
  workspaceRoot: string,
  caseRoot: string,
): Promise<void> {
  if (agent === 'agent-runlab') {
    await runCommand('pnpm', [
      '--filter', '@agent-kernel/host', 'exec', 'tsx', 'bin/run-agent-runlab-prompt.ts',
      '--prompt-file', promptPath,
      '--cwd', workspaceRoot,
      '--response-file', responsePath,
      '--session-log', join(caseRoot, 'agent-runlab-session.jsonl'),
      '--metadata-file', join(caseRoot, 'agent-runlab-metadata.json'),
      '--sessions-dir', join(caseRoot, 'sessions'),
      '--artifacts-dir', join(caseRoot, 'artifacts'),
      '--model', args.model,
      '--system-prompt-preset', 'codex',
      '--timeout-ms', String(args.timeoutMs),
      '--max-turns', String(args.maxTurns),
      '--disable-web-tools',
    ], caseRoot, {
      ANTHROPIC_BASE_URL: args.baseUrl,
      ANTHROPIC_MODEL: args.model,
      ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
      HOST_MODEL: args.model,
    }, 'agent-runlab')
    return
  }
  await runCommand('pnpm', [
    '--filter', '@agent-kernel/host', 'exec', 'tsx', 'bin/run-claude-code-prompt.ts',
    '--prompt-file', promptPath,
    '--cwd', workspaceRoot,
    '--response-file', responsePath,
    '--artifacts-dir', join(caseRoot, 'claude-code-artifacts'),
    ...explicitBaseUrlArg(args),
    '--model', args.model,
    '--small-fast-model', args.smallFastModel,
    '--timeout-ms', String(args.timeoutMs),
    '--max-turns', String(args.maxTurns),
    '--disable-web-tools',
  ], caseRoot, {
    ANTHROPIC_BASE_URL: args.baseUrl,
    ANTHROPIC_MODEL: args.model,
    ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
  }, 'claude-code')
}

async function collectDeliverables(workspaceRoot: string, deliverablesRoot: string): Promise<DeliverableManifest> {
  await rm(deliverablesRoot, { recursive: true, force: true })
  await mkdir(deliverablesRoot, { recursive: true })
  const preferred = join(workspaceRoot, 'deliverables')
  const sourceRoot = existsSync(preferred) ? preferred : workspaceRoot
  const files = await listFiles(sourceRoot, workspaceRoot)
  for (const file of files) {
    const rel = relative(sourceRoot, file)
    if (shouldSkipWorkspaceFile(relative(workspaceRoot, file))) continue
    await mkdir(dirname(join(deliverablesRoot, rel)), { recursive: true })
    await cp(file, join(deliverablesRoot, rel), { force: true })
  }
  const copied = await listFiles(deliverablesRoot, deliverablesRoot)
  const manifestFiles = []
  for (const file of copied) {
    const bytes = await readFile(file)
    manifestFiles.push({
      path: normalizeRelative(deliverablesRoot, file),
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return {
    schema_version: 1,
    workspace_root: workspaceRoot,
    files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
  }
}

async function listFiles(root: string, workspaceRoot: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const rel = relative(workspaceRoot, path)
      if (entry.isDirectory()) {
        if (shouldSkipWorkspaceFile(rel)) continue
        await visit(path)
      } else if (entry.isFile()) {
        if (shouldSkipWorkspaceFile(rel)) continue
        const info = await stat(path)
        if (info.size <= 25 * 1024 * 1024) out.push(path)
      }
    }
  }
  await visit(root)
  return out
}

function shouldSkipWorkspaceFile(rel: string): boolean {
  const normalized = rel.replaceAll('\\', '/')
  return normalized === ''
    || normalized.startsWith('.agent-home/')
    || normalized.startsWith('.claude-home/')
    || normalized.startsWith('node_modules/')
    || normalized.startsWith('.git/')
}

async function fetchJobBenchCases(split: 'easy' | 'main'): Promise<JobBenchCase[]> {
  const url = `https://datasets-server.huggingface.co/rows?dataset=JobBench%2Fjob-bench&config=default&split=${split}&offset=0&length=100`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to fetch JobBench ${split} rows: ${res.status} ${res.statusText}`)
  const body = await res.json() as { rows?: Array<{ row?: Record<string, unknown> }> }
  const rows = body.rows ?? []
  return rows.map(({ row }) => {
    if (!row) throw new Error('missing row in JobBench dataset response')
    const taskId = stringField(row, 'task_id')
    return {
      benchmark: 'job-bench',
      instance_id: `${split}:${taskId}`,
      split,
      occupation: stringField(row, 'occupation'),
      task_num: numberField(row, 'task_num'),
      prompt: stringField(row, 'prompt'),
      reference_files: stringListField(row, 'reference_files'),
      reference_file_urls: stringListField(row, 'reference_file_urls'),
      reference_file_hf_uris: stringListField(row, 'reference_file_hf_uris'),
      rubric_json: stringField(row, 'rubric_json'),
      task_card: stringField(row, 'task_card'),
    }
  })
}

function selectDeterministicSubset(allCases: readonly JobBenchCase[], args: Args): JobBenchCase[] {
  const sorted = [...allCases].sort((a, b) => a.instance_id.localeCompare(b.instance_id))
  const shuffled = seededShuffle(sorted, args.seed)
  return shuffled.slice(args.offset, args.offset + args.limit).sort((a, b) => a.instance_id.localeCompare(b.instance_id))
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed >>> 0
  const next = () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x100000000
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

async function writeSelectedCases(args: Args, selected: readonly JobBenchCase[]): Promise<void> {
  await mkdir(dirname(args.selectedCasesPath), { recursive: true })
  await writeFile(args.selectedCasesPath, selected.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const summary = {
    schema_version: 1,
    benchmark: 'job-bench',
    split: args.split,
    selected_cases: selected.length,
    selection_rule: `Fetch JobBench/job-bench ${args.split} split metadata from Hugging Face rows API, sort by instance_id, seeded shuffle with LCG seed ${args.seed}, take offset ${args.offset}, limit ${args.limit}, then sort selected ids for stable output.`,
    seed: args.seed,
    offset: args.offset,
    limit: args.limit,
    occupations: Object.fromEntries(countBy(selected.map((row) => row.occupation))),
    selected_case_ids: selected.map((row) => row.instance_id),
  }
  await writeFile(join(args.legacy-runnerDir, 'reports/jobbench/benchmark-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
}

async function writeOutputs(
  args: Args,
  runRoot: string,
  cases: readonly JobBenchCase[],
  results: readonly InstanceResult[],
  stopReason: string | null,
): Promise<void> {
  const root = join(args.legacy-runnerDir, 'artifacts', 'job-bench')
  const gradingDir = join(root, 'grading')
  await mkdir(gradingDir, { recursive: true })
  const instanceResults = results.map((row) => JSON.stringify(row)).join('\n') + (results.length ? '\n' : '')
  await writeFile(join(runRoot, 'instance-results.jsonl'), instanceResults, 'utf8')
  await writeFile(join(gradingDir, 'instance-results.jsonl'), instanceResults, 'utf8')
  const summary = {
    schema_version: 1,
    benchmark: 'job-bench',
    run_id: args.runId,
    status: args.dryRun ? 'dry_run' : stopReason ? 'partial_stopped' : results.every((row) => row.status === 'scored') ? 'scored' : 'submitted_unscored',
    stop_reason: stopReason,
    split: args.split,
    selected_cases: cases.length,
    model: args.model,
    judge_model: args.judgeModel,
    scorer: args.runJudge ? 'jobbench.rubric-judge' : 'jobbench.rubric-judge.not_run',
    official: results.length > 0 && results.every((row) => row.official),
    completed_agent_runs: args.dryRun ? 0 : results.length,
    planned_agent_runs: args.dryRun ? results.length : undefined,
    requested_agent_runs: cases.length * args.agents.length,
    agents: Object.fromEntries(args.agents.map((agent) => {
      const rows = results.filter((row) => row.agent === agent)
      return [agent, {
        attempted: rows.length,
        prepared: rows.filter((row) => row.status === 'prepared').length,
        submitted: rows.filter((row) => row.status === 'submitted').length,
        scored: rows.filter((row) => row.status === 'scored').length,
        errors: rows.filter((row) => row.status === 'error').length,
        average_score: rows.length ? rows.reduce((sum, row) => sum + row.score, 0) / rows.length : 0,
      }]
    })),
    run_root: relativeToLegacy Runner(args.legacy-runnerDir, runRoot),
  }
  await writeFile(join(runRoot, 'score-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await writeFile(join(gradingDir, 'score-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await mkdir(join(args.legacy-runnerDir, 'reports', 'jobbench'), { recursive: true })
  await writeFile(join(args.legacy-runnerDir, 'reports', 'jobbench', 'latest-run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await writePairwise(args, runRoot, results)
}

async function writePairwise(args: Args, runRoot: string, results: readonly InstanceResult[]): Promise<void> {
  const root = join(args.legacy-runnerDir, 'artifacts', 'job-bench')
  const byKey = new Map(results.map((row) => [`${row.instance_id}:${row.agent}`, row]))
  const ids = [...new Set(results.map((row) => row.instance_id))].sort()
  const rows = ids.map((id) => {
    const agent = byKey.get(`${id}:agent-runlab`)
    const claude = byKey.get(`${id}:claude-code`)
    return {
      benchmark: 'job-bench',
      instance_id: id,
      task_type: 'workplace_file_task',
      split: agent?.split ?? claude?.split ?? args.split,
      model: args.model,
      agent_runlab_status: agent?.status ?? 'not_run',
      claude_code_status: claude?.status ?? 'not_run',
      agent_runlab_score: String(agent?.score ?? 0),
      claude_code_score: String(claude?.score ?? 0),
      winner: pairwiseWinner(agent, claude),
      agent_artifact: agent?.artifact_refs.join(';') ?? '',
      claude_artifact: claude?.artifact_refs.join(';') ?? '',
      grader_report: 'artifacts/job-bench/grading/instance-results.jsonl',
      failure_category: args.dryRun ? '' : pairwiseFailureCategory(agent, claude),
      notes: pairwiseNotes(args, agent, claude),
    }
  })
  const header = Object.keys(rows[0] ?? {
    benchmark: '', instance_id: '', task_type: '', split: '', model: '', agent_runlab_status: '', claude_code_status: '',
    agent_runlab_score: '', claude_code_score: '', winner: '', agent_artifact: '', claude_artifact: '', grader_report: '', failure_category: '', notes: '',
  })
  const csv = [header.join(','), ...rows.map((row) => header.map((key) => csvCell(String(row[key as keyof typeof row]))).join(','))].join('\n') + '\n'
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
  const reportRoot = join(args.legacy-runnerDir, 'reports', 'jobbench')
  await mkdir(reportRoot, { recursive: true })
  await writeFile(join(reportRoot, 'pairwise-comparison.csv'), csv, 'utf8')
  await writeFile(join(reportRoot, 'pairwise-comparison.jsonl'), jsonl, 'utf8')
  await writeFile(join(runRoot, 'pairwise-comparison.csv'), csv, 'utf8')
  await writeFile(join(runRoot, 'pairwise-comparison.jsonl'), jsonl, 'utf8')
}

function pairwiseWinner(agent?: InstanceResult, claude?: InstanceResult): string {
  if (!agent || !claude) return 'not_comparable'
  if (!agent.official || !claude.official) return 'not_comparable'
  if (agent.score > claude.score) return 'agent-runlab'
  if (claude.score > agent.score) return 'claude-code'
  return 'tie'
}

function pairwiseFailureCategory(agent?: InstanceResult, claude?: InstanceResult): string {
  const rows = [agent, claude].filter((row): row is InstanceResult => row !== undefined)
  if (!rows.length || rows.some((row) => row.status === 'not_run')) return 'not_comparable'
  if (rows.some((row) => row.status === 'error')) return 'runner_infrastructure_error'
  if (rows.some((row) => row.error_type?.includes('max_turns') || row.error_type?.includes('maximum number of turns'))) return 'incomplete_execution'
  if (rows.some((row) => row.status === 'submitted')) return 'pending_judge'
  if (rows.some((row) => row.official && row.score === 0)) return 'rubric_failure'
  return ''
}

function pairwiseNotes(args: Args, agent?: InstanceResult, claude?: InstanceResult): string {
  if (args.dryRun) return 'dry run only; no agent, deliverable, or rubric judge executed'
  if (!agent || !claude) return 'missing one side of pairwise comparison'
  if (agent.status === 'error' || claude.status === 'error') return 'one or both agent runs failed before judgeable deliverables'
  if (!args.runJudge) return 'agent runs completed and deliverables were archived; rubric judge intentionally not run'
  if (!agent.official || !claude.official) return 'rubric judge pending for one or both systems'
  return 'rubric judge completed for both systems'
}

function runStopReason(args: Args, results: readonly InstanceResult[], requestedAgentRuns: number): string | null {
  if (args.dryRun) return null
  if (results.length >= requestedAgentRuns) return null
  if (args.maxAgentRuns !== undefined && results.length >= args.maxAgentRuns) return `max_agent_runs:${args.maxAgentRuns}`
  const errors = results.filter((row) => row.status === 'error').length
  if (args.stopAfterErrors !== undefined && errors >= args.stopAfterErrors) return `stop_after_errors:${args.stopAfterErrors}`
  return null
}

async function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  logLabel?: string,
): Promise<void> {
  await mkdir(cwd, { recursive: true })
  const logPath = join(cwd, `${basename(logLabel ?? cmd)}-${createHash('sha1').update(args.join('\0')).digest('hex').slice(0, 8)}.log`)
  await writeFile(logPath, `$ ${cmd} ${args.join(' ')}\n`, 'utf8')
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => void append(logPath, chunk))
    child.stderr.on('data', (chunk) => void append(logPath, chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} exited with ${code}; see ${logPath}`))
    })
  })
}

async function append(path: string, chunk: Buffer): Promise<void> {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path, chunk)
}

function joinPath(base: string, tail: string): string {
  const trimmed = base.replace(/\/+$/, '').replace(/\/messages$/, '')
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${versioned}${tail.startsWith('/') ? tail : `/${tail}`}`
}

function selectRunCases(allCases: readonly JobBenchCase[], args: Args): JobBenchCase[] {
  if (!args.caseIds.length) return [...allCases]
  const byId = new Map(allCases.map((item) => [item.instance_id, item]))
  return args.caseIds.map((id) => {
    const item = byId.get(id)
    if (!item) throw new Error(`case id not found in ${args.selectedCasesPath}: ${id}`)
    return item
  })
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)
}

function parseArgs(argv: readonly string[]): Args {
  loadEnvFile(value(argv, '--env-file') ?? defaultBenchmarkEnvPath(REPO_ROOT), { override: true, sourceName: 'env-file' })
  const anthropicDefaults = loadAnthropicCliDefaults()
  const baseUrl = requireAnthropicBaseUrl({ explicit: value(argv, '--base-url'), defaults: anthropicDefaults })
  const legacy-runnerDir = resolve(REPO_ROOT, value(argv, '--legacy-runner-dir') ?? 'experiments/evals/2026-07-agent-benchmark-comparison')
  const split = value(argv, '--split') === 'main' ? 'main' : 'easy'
  const selectedCasesPath = resolve(value(argv, '--selected-cases') ?? join(legacy-runnerDir, 'planning/jobbench/selected-cases.jsonl'))
  const agents = (value(argv, '--agents') ?? 'agent-runlab,claude-code')
    .split(',')
    .map((agent) => agent.trim())
    .filter(Boolean) as AgentName[]
  for (const agent of agents) {
    if (agent !== 'agent-runlab' && agent !== 'claude-code') throw new Error(`unknown agent: ${agent}`)
  }
  return {
    legacy-runnerDir,
    split,
    selectedCasesPath,
    agents,
    model: value(argv, '--model') ?? process.env.HOST_MODEL ?? anthropicDefaults.model ?? 'claude-sonnet-4-6',
    baseUrl: baseUrl.baseUrl,
    baseUrlSource: baseUrl.source,
    smallFastModel: value(argv, '--small-fast-model') ?? anthropicDefaults.smallFastModel ?? 'claude-haiku-4-5',
    timeoutMs: numberValue(argv, '--timeout-ms') ?? 30 * 60_000,
    maxTurns: numberValue(argv, '--max-turns') ?? 40,
    maxAgentRuns: numberValue(argv, '--max-agent-runs'),
    stopAfterErrors: numberValue(argv, '--stop-after-errors'),
    judgeModel: value(argv, '--judge-model') ?? process.env.JOBBENCH_JUDGE_MODEL ?? 'grok-4.3',
    judgeProvider: value(argv, '--judge-provider') === 'openai' ? 'openai' : 'anthropic',
    judgeBaseUrl: value(argv, '--judge-base-url') ?? process.env.JOBBENCH_JUDGE_BASE_URL,
    seed: numberValue(argv, '--seed', { allowZero: true }) ?? 0,
    limit: numberValue(argv, '--limit') ?? 30,
    offset: numberValue(argv, '--offset', { allowZero: true }) ?? 0,
    caseIds: values(argv, '--case-id'),
    runId: value(argv, '--run-id') ?? `job-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    prepareSubset: hasFlag(argv, '--prepare-subset'),
    downloadReferenceFiles: hasFlag(argv, '--download-reference-files'),
    runJudge: hasFlag(argv, '--run-judge'),
    dryRun: hasFlag(argv, '--dry-run'),
  }
}

function explicitBaseUrlArg(args: Pick<Args, 'baseUrl' | 'baseUrlSource'>): string[] {
  return args.baseUrlSource === 'cli' ? ['--base-url', args.baseUrl] : []
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`JobBench row field ${key} is not a string`)
  return value
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number') throw new Error(`JobBench row field ${key} is not a number`)
  return value
}

function stringListField(row: Record<string, unknown>, key: string): string[] {
  const value = row[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`JobBench row field ${key} is not a string list`)
  }
  return value as string[]
}

function countBy(valuesToCount: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const item of valuesToCount) out.set(item, (out.get(item) ?? 0) + 1)
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function value(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function values(argv: readonly string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name && argv[i + 1]) out.push(argv[i + 1]!)
    else if (arg.startsWith(`${name}=`)) out.push(arg.slice(name.length + 1))
  }
  return out.flatMap((raw) => raw.split(',').map((item) => item.trim()).filter(Boolean))
}

function numberValue(argv: readonly string[], name: string, opts: { allowZero?: boolean } = {}): number | undefined {
  const raw = value(argv, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  const min = opts.allowZero ? 0 : 1
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be ${opts.allowZero ? 'a non-negative' : 'a positive'} number`)
  return n
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

function relativeToLegacy Runner(legacy-runnerDir: string, path: string): string {
  return normalizeRelative(resolve(legacy-runnerDir), resolve(path))
}

function normalizeRelative(from: string, to: string): string {
  let rel = to.startsWith(from) ? to.slice(from.length).replace(/^\/+/, '') : to
  rel = rel.replaceAll('\\', '/')
  return rel
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
