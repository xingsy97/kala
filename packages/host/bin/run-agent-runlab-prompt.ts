#!/usr/bin/env tsx
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { CallToolEffect, Message } from '@agent-kernel/kernel'
import type { ModelInfo } from '@agent-kernel/shared'
import { deriveEvalMemoryPolicy } from '@agent-kernel/shared/enhancement'
import {
  allTools,
  createSandbox,
  createToolRegistry,
  ToolError,
} from '@agent-kernel/executor'
import type { ToolContext } from '@agent-kernel/executor'
import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import { routerAdapter } from '../src/llm/router.js'
import type { LLMAdapter, LLMCallParams, LLMResponse } from '../src/llm/adapter.js'
import { runHostLoop } from '../src/loop.js'
import type { LoopBroadcast, ToolDispatcher } from '../src/loop-types.js'
import { createRuntimeLogger } from '../src/logger.js'
import { resolveBuiltinAgentModule, type AgentSystemPromptPreset } from '../src/builtin-tools.js'
import {
  defaultBenchmarkEnvPath,
  knownContextWindow,
  loadEnvFile,
  loadRuntimeConfig,
  modelInfo,
  type ProviderSpec,
} from '../src/runtime-config.js'
import { SessionStore } from '../src/store/session.js'
import { rewriteHostWorkspacePathForContainer } from '../src/eval/programbench/programbench-bash.js'
import {
  compareProgramBenchSubmissionContracts,
  inspectProgramBenchSubmissionContract,
  type ProgramBenchSubmissionContract,
  type ProgramBenchSubmissionContractProgress,
} from '../src/eval/programbench/programbench-contract.js'
import { classifyProgramBenchCompletionControl, type ProgramBenchCompletionControl } from '../src/eval/programbench/programbench-completion.js'
import { buildProgramBenchContractRepairPrompt } from '../src/eval/programbench/programbench-prompt.js'

type Args = {
  promptFile: string
  continuationPromptFiles: readonly string[]
  cwd: string
  responseFile: string
  sessionLog: string
  sessionsDir: string
  artifactsDir: string
  metadataFile?: string
  model?: string
  systemPromptPreset: AgentSystemPromptPreset
  disableWebTools: boolean
  bashDockerImage?: string
  maxTurns: number
  continuationMaxTurns: number
  maxWebToolCalls?: number
  maxOutputTokens?: number
  timeoutMs: number
  inactivityTimeoutMs?: number
  programbenchCaseJson?: string
  programbenchContractContinuationAttempts: number
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

type ProgramBenchCase = {
  instance_id: string
  repository?: string
  language?: string
  difficulty?: string | null
}

type ContractContinuationAttemptSummary = {
  attempt: number
  prompt: string
  response: string
  before: {
    ok: boolean
    reason_codes: readonly string[]
    source_file_count: number
    source_files: readonly string[]
    implementation_file_count: number
    implementation_files: readonly string[]
  }
  after: {
    ok: boolean
    reason_codes: readonly string[]
    source_file_count: number
    source_files: readonly string[]
    implementation_file_count: number
    implementation_files: readonly string[]
  }
  progress: ProgramBenchSubmissionContractProgress
  completion_control?: ProgramBenchCompletionControl
  error: string | null
}

const WEB_TOOL_NAMES = new Set(['websearch', 'webfetch'])
const BASH_OUTPUT_LIMIT = 1_000_000

const logger = createRuntimeLogger('prompt-agent-runlab')

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await mkdir(args.sessionsDir, { recursive: true })
  await mkdir(args.artifactsDir, { recursive: true })
  const isolatedHome = join(args.cwd, '.agent-home')
  await mkdir(isolatedHome, { recursive: true })

  const prompts = [args.promptFile, ...args.continuationPromptFiles]
  const runtime = loadRuntimeConfig()
  const registry = createModelRegistry(runtime.providers, runtime.manualModels, {
    fallbackDefault: runtime.defaultModel,
    maxOutputTokens: args.maxOutputTokens,
  })
  const selectedModel = args.model ?? process.env.HOST_MODEL ?? registry.defaultModel
  if (!selectedModel) {
    throw new Error('No model selected. Set --model, HOST_MODEL, or configure a provider default.')
  }
  const resolved = resolveBuiltinAgentModule({
    systemPromptPreset: args.systemPromptPreset,
    ...(knownContextWindow(selectedModel) ? { contextLimit: knownContextWindow(selectedModel) } : {}),
  })
  const config = args.disableWebTools
    ? { ...resolved.config, tools: resolved.config.tools.filter((tool) => !WEB_TOOL_NAMES.has(tool.name)) }
    : resolved.config
  const store = new SessionStore(args.sessionsDir)
  const sessionId = `prompt-${sanitize(process.env.AGENT_KERNEL_BENCHMARK_INSTANCE_ID ?? 'case')}-${Date.now()}`
  const record = await store.create({
    sessionId,
    config,
    initialCwd: args.cwd,
    initialApprovalMode: 'allow_all',
    memoryPolicy: deriveEvalMemoryPolicy({ benchmarkIsolation: true }),
  })
  const toolEnv = { ...process.env, HOME: isolatedHome, AGENT_KERNEL_WORKSPACE: args.cwd }
  const toolDispatcher = createInProcessToolDispatcher(args.cwd, {
    disableWebTools: args.disableWebTools,
    env: toolEnv,
    bashDockerImage: args.bashDockerImage,
    maxWebToolCalls: args.maxWebToolCalls,
  })
  const programbenchCase = args.programbenchCaseJson
    ? JSON.parse(await readText(args.programbenchCaseJson)) as ProgramBenchCase
    : undefined
  const caseRoot = dirname(args.responseFile)
  let llmResponses = 0
  let turnLimitHit = false
  const promptBudget = createPromptBudgetGate(args.maxTurns)
  let activeInactivityWatchdog: ReturnType<typeof createInactivityWatchdog> | undefined
  const broadcast: LoopBroadcast = {
    onEvent(_sessionId, seq, event, _effects, state, _llmTrace, model) {
      activeInactivityWatchdog?.beat()
      if (event.kind === 'llm_response') {
        llmResponses += 1
        if (promptBudget.recordResponse(llmResponses)) {
          turnLimitHit = true
          process.stderr.write(`[agent-runlab] reached prompt max turns ${promptBudget.maxTurns()}; blocking follow-up LLM calls after pending tools drain for ${sessionId}\n`)
        }
      }
      process.stderr.write(`[agent-runlab] ${JSON.stringify({
        seq,
        event: event.kind,
        status: state.status,
        pendingCalls: state.pendingCalls.length,
        ...(model ? { model } : {}),
      })}\n`)
    },
    onApprovalRequired(_sessionId, eff) {
      activeInactivityWatchdog?.beat()
      process.stderr.write(`[agent-runlab] unexpected approval request for ${eff.name}:${eff.callId}\n`)
    },
    onError(_sessionId, message) {
      activeInactivityWatchdog?.beat()
      process.stderr.write(`[agent-runlab] error: ${message}\n`)
    },
  }
  const loop = runHostLoop({
    store,
    llm: budgetedLlmAdapter(registry.llm, () => promptBudget.isExhausted()),
    tools: toolDispatcher,
    broadcast,
    models: { get: () => selectedModel },
    artifactRootDir: args.artifactsDir,
  })
  let completedPrompts = 0
  const continuationAttempts: ContractContinuationAttemptSummary[] = []
  let runError: unknown
  try {
    for (const [index, promptFile] of prompts.entries()) {
      const prompt = await readText(promptFile)
      process.stderr.write(`[agent-runlab] dispatching prompt ${index + 1}/${prompts.length}: ${promptFile}\n`)
      promptBudget.start(llmResponses, index === 0 ? args.maxTurns : args.continuationMaxTurns)
      const inactivity = args.inactivityTimeoutMs !== undefined
        ? createInactivityWatchdog(args.inactivityTimeoutMs, () => {
            process.stderr.write(`[agent-runlab] inactivity timeout after ${args.inactivityTimeoutMs}ms; cancelling session ${sessionId}\n`)
            loop.cancelStream(sessionId)
            void loop.dispatch(sessionId, { kind: 'cancel' }).catch(() => {})
          })
        : undefined
      activeInactivityWatchdog = inactivity
      await withTimeout(
        inactivity ? inactivity.wrap(loop.dispatch(sessionId, { kind: 'user_message', text: prompt })) : loop.dispatch(sessionId, { kind: 'user_message', text: prompt }),
        args.timeoutMs,
        () => {
          process.stderr.write(`[agent-runlab] timeout after ${args.timeoutMs}ms; cancelling session ${sessionId}\n`)
          loop.cancelStream(sessionId)
          void loop.dispatch(sessionId, { kind: 'cancel' }).catch(() => {})
        },
      )
      activeInactivityWatchdog = undefined
      completedPrompts += 1
    }
    if (programbenchCase && args.programbenchContractContinuationAttempts > 0) {
      await writeInitialProgramBenchContract(caseRoot, args.cwd)
      const continuation = await runProgramBenchContractContinuations({
        args,
        loop,
        store,
        sessionId,
        caseRoot,
        programbenchCase,
        setActiveInactivityWatchdog(watchdog) {
          activeInactivityWatchdog = watchdog
        },
        setPromptBudget(maxTurns) {
          promptBudget.start(llmResponses, maxTurns)
        },
      })
      continuationAttempts.push(...continuation.attempts)
      completedPrompts += continuation.completedPrompts
    }
  } catch (err: unknown) {
    runError = err
  } finally {
    activeInactivityWatchdog = undefined
    toolDispatcher.cancelPending(sessionId)
  }
  if (turnLimitHit) {
    process.stderr.write(`[agent-runlab] reached max turns ${args.maxTurns}\n`)
  }
  const finalRecord = store.get(sessionId)
  const responseText = finalRecord ? extractLastAssistantText(finalRecord.state.messages) : ''
  const finalProgramBenchContract = programbenchCase ? await inspectProgramBenchSubmissionContract(args.cwd) : null
  const finalProgramBenchCompletionControl = finalProgramBenchContract
    ? classifyProgramBenchCompletionControl({ contract: finalProgramBenchContract, responseText })
    : null
  await mkdir(dirname(args.responseFile), { recursive: true })
  await writeFile(args.responseFile, responseText, 'utf8')
  await mkdir(dirname(args.sessionLog), { recursive: true })
  await copyFile(record.logPath, args.sessionLog)
  const finalStatus = finalRecord?.state.status ?? 'unknown'
  const metadata = {
    sessionId,
    sessionLog: record.logPath,
    responseFile: args.responseFile,
    status: finalStatus,
    turnLimitHit,
    llmResponses,
    webToolCalls: toolDispatcher.webToolCalls(),
    maxWebToolCalls: args.maxWebToolCalls ?? null,
    maxOutputTokens: args.maxOutputTokens ?? null,
    promptFiles: prompts,
    completedPrompts,
    error: runError instanceof Error ? runError.message : runError ? String(runError) : null,
    contractContinuationAttempts: continuationAttempts,
    ...(finalProgramBenchContract
      ? {
          programbenchSubmissionContract: finalProgramBenchContract,
          programbenchCompletionControl: finalProgramBenchCompletionControl,
        }
      : {}),
    model: selectedModel,
    systemPromptPreset: args.systemPromptPreset,
    disabledTools: args.disableWebTools ? [...WEB_TOOL_NAMES].sort() : [],
    bashDockerImage: args.bashDockerImage,
    isolatedHome,
  }
  if (args.metadataFile) {
    await mkdir(dirname(args.metadataFile), { recursive: true })
    await writeFile(args.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`)
  if (runError) {
    throw runError
  }
  if (finalStatus === 'error') {
    throw new Error(`Agent RunLab session ended in error; see ${args.sessionLog}`)
  }
  if (turnLimitHit && responseText.length === 0) {
    throw new Error(`Agent RunLab reached max turns without assistant text; see ${args.sessionLog}`)
  }
}

async function writeInitialProgramBenchContract(caseRoot: string, workspaceRoot: string): Promise<void> {
  const initialPath = join(caseRoot, 'submission-contract.initial.json')
  if (existsSync(initialPath)) return
  const contract = await inspectProgramBenchSubmissionContract(workspaceRoot)
  await writeFile(initialPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
}

async function runProgramBenchContractContinuations(input: {
  args: Args
  loop: ReturnType<typeof runHostLoop>
  store: SessionStore
  sessionId: string
  caseRoot: string
  programbenchCase: ProgramBenchCase
  setActiveInactivityWatchdog(watchdog: ReturnType<typeof createInactivityWatchdog> | undefined): void
  setPromptBudget(maxTurns: number): void
}): Promise<{ attempts: ContractContinuationAttemptSummary[]; completedPrompts: number }> {
  const attempts: ContractContinuationAttemptSummary[] = []
  let completedPrompts = 0
  let contract = await inspectProgramBenchSubmissionContract(input.args.cwd)
  const maxAttempts = Math.max(0, input.args.programbenchContractContinuationAttempts)

  for (let attempt = 1; attempt <= maxAttempts && !contract.ok; attempt++) {
    const legacyFirstAttempt = attempt === 1
    const promptPath = join(input.caseRoot, legacyFirstAttempt ? 'contract-repair-prompt.txt' : `contract-continuation-${attempt}-prompt.txt`)
    const responsePath = join(input.caseRoot, legacyFirstAttempt ? 'contract-repair-response.txt' : `contract-continuation-${attempt}-response.txt`)
    const errorPath = join(input.caseRoot, legacyFirstAttempt ? 'contract-repair-error.txt' : `contract-continuation-${attempt}-error.txt`)
    const before = contract
    const prompt = buildProgramBenchContractRepairPrompt(input.programbenchCase, input.args.cwd, before)
    await writeFile(promptPath, prompt, 'utf8')

    let attemptError: string | null = null
    try {
      input.setPromptBudget(input.args.continuationMaxTurns)
      const inactivity = input.args.inactivityTimeoutMs !== undefined
        ? createInactivityWatchdog(input.args.inactivityTimeoutMs, () => {
            process.stderr.write(`[agent-runlab] inactivity timeout after ${input.args.inactivityTimeoutMs}ms during contract continuation; cancelling session ${input.sessionId}\n`)
            input.loop.cancelStream(input.sessionId)
            void input.loop.dispatch(input.sessionId, { kind: 'cancel' }).catch(() => {})
          })
        : undefined
      input.setActiveInactivityWatchdog(inactivity)
      await withTimeout(
        inactivity ? inactivity.wrap(input.loop.dispatch(input.sessionId, { kind: 'user_message', text: prompt })) : input.loop.dispatch(input.sessionId, { kind: 'user_message', text: prompt }),
        input.args.timeoutMs,
        () => {
          process.stderr.write(`[agent-runlab] timeout after ${input.args.timeoutMs}ms during contract continuation; cancelling session ${input.sessionId}\n`)
          input.loop.cancelStream(input.sessionId)
          void input.loop.dispatch(input.sessionId, { kind: 'cancel' }).catch(() => {})
        },
      )
      input.setActiveInactivityWatchdog(undefined)
      completedPrompts += 1
    } catch (err: unknown) {
      input.setActiveInactivityWatchdog(undefined)
      attemptError = err instanceof Error ? err.message : String(err)
      await writeFile(errorPath, `${attemptError}\n`, 'utf8')
    }

    contract = await inspectProgramBenchSubmissionContract(input.args.cwd)
    const progress = compareProgramBenchSubmissionContracts(before, contract)
    const finalRecord = input.store.get(input.sessionId)
    const responseText = finalRecord ? extractLastAssistantText(finalRecord.state.messages) : ''
    const completionControl = classifyProgramBenchCompletionControl({ contract, progress, responseText })
    await writeFile(responsePath, responseText, 'utf8')

    attempts.push({
      attempt,
      prompt: promptPath,
      response: responsePath,
      before: summarizeContract(before),
      after: summarizeContract(contract),
      progress,
      completion_control: completionControl,
      error: attemptError,
    })
    if (!contract.ok && completionControl.action === 'stop_no_progress') {
      process.stderr.write(`[agent-runlab] stopping ProgramBench contract continuation after attempt ${attempt}: ${completionControl.classification}\n`)
      break
    }
  }

  const exhausted = !contract.ok && maxAttempts > 0 && attempts.length >= maxAttempts
  await writeFile(join(input.caseRoot, 'contract-continuation-summary.json'), `${JSON.stringify({
    schema_version: 1,
    mode: 'same_session',
    enabled: true,
    max_attempts: maxAttempts,
    repair_max_turns: input.args.continuationMaxTurns,
    attempted: attempts.length,
    exhausted,
    final_ok: contract.ok,
    final_reason_codes: contract.reason_codes,
    stopped_after_no_progress: attempts.length > 0 && attempts.at(-1)?.completion_control?.action === 'stop_no_progress',
    final_progress_classification: attempts.at(-1)?.progress.classification ?? null,
    final_completion_control: attempts.at(-1)?.completion_control ?? null,
    attempts: attempts.map((attempt) => ({
      ...attempt,
      prompt: relative(input.caseRoot, attempt.prompt).replaceAll(sep, '/'),
      response: relative(input.caseRoot, attempt.response).replaceAll(sep, '/'),
    })),
  }, null, 2)}\n`, 'utf8')

  return { attempts, completedPrompts }
}

function summarizeContract(contract: ProgramBenchSubmissionContract): {
  ok: boolean
  reason_codes: readonly string[]
  source_file_count: number
  source_files: readonly string[]
  implementation_file_count: number
  implementation_files: readonly string[]
} {
  return {
    ok: contract.ok,
    reason_codes: contract.reason_codes,
    source_file_count: contract.source_file_count,
    source_files: contract.source_files,
    implementation_file_count: contract.implementation_file_count,
    implementation_files: contract.implementation_files,
  }
}

function createInProcessToolDispatcher(root: string, opts: { disableWebTools: boolean; env?: NodeJS.ProcessEnv; bashDockerImage?: string; maxWebToolCalls?: number }): ToolDispatcher & { webToolCalls(): number } {
  const sandbox = createSandbox({ roots: [root] })
  const visibleTools = opts.disableWebTools ? allTools.filter((tool) => !WEB_TOOL_NAMES.has(tool.name)) : allTools
  const tools = createToolRegistry(visibleTools)
  const inFlight = new Map<string, AbortController>()
  let webToolCalls = 0
  return {
    async callTool(sessionId: string, eff: CallToolEffect) {
      const tool = tools.get(eff.name)
      if (!tool) return { ok: false, content: `ERROR: unknown tool: ${eff.name}` }
      if (WEB_TOOL_NAMES.has(eff.name)) {
        webToolCalls += 1
        if (opts.maxWebToolCalls !== undefined && webToolCalls > opts.maxWebToolCalls) {
          return { ok: false, content: `ERROR: EWEB_BUDGET_EXHAUSTED: web evidence call budget exhausted (${opts.maxWebToolCalls})` }
        }
      }
      const controller = new AbortController()
      inFlight.set(eff.callId, controller)
      try {
        const ctx: ToolContext = {
          sessionId,
          sandbox,
          signal: controller.signal,
          ...(opts.env ? { env: opts.env } : {}),
          ...(eff.cwd ? { cwd: eff.cwd } : {}),
        }
        const content = opts.bashDockerImage && eff.name === 'bash'
          ? await runContainerizedBashTool(eff.input, ctx, root, opts.bashDockerImage)
          : await tool.run(eff.input, ctx)
        return { ok: true, content }
      } catch (err: unknown) {
        const message = err instanceof ToolError || err instanceof Error ? err.message : String(err)
        return { ok: false, content: `ERROR: ${message}` }
      } finally {
        inFlight.delete(eff.callId)
      }
    },
    cancelPending() {
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
    },
    webToolCalls() {
      return webToolCalls
    },
  }
}

export function budgetedLlmAdapter(inner: LLMAdapter, isBudgetExhausted: () => boolean): LLMAdapter {
  return {
    name: `${inner.name}:budgeted`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      if (isBudgetExhausted()) {
        return {
          message: { role: 'assistant', content: [] },
          finishReason: 'agent_runlab_prompt_turn_limit',
        }
      }
      return inner.call(params)
    },
  }
}

export function createPromptBudgetGate(initialMaxTurns: number): {
  start(completedResponses: number, maxTurns: number): void
  recordResponse(totalResponses: number): boolean
  isExhausted(): boolean
  maxTurns(): number
} {
  let promptStartResponses = 0
  let promptMaxTurns = initialMaxTurns
  let exhausted = false

  return {
    start(completedResponses, maxTurns) {
      promptStartResponses = completedResponses
      promptMaxTurns = maxTurns
      exhausted = false
    },
    recordResponse(totalResponses) {
      if (exhausted) return false
      const promptResponses = totalResponses - promptStartResponses
      if (promptResponses >= promptMaxTurns) {
        exhausted = true
        return true
      }
      return false
    },
    isExhausted() {
      return exhausted
    },
    maxTurns() {
      return promptMaxTurns
    },
  }
}

async function runContainerizedBashTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
  workspaceRoot: string,
  image: string,
): Promise<string> {
  const command = typeof input.command === 'string' ? input.command : undefined
  if (!command || command.trim().length === 0) throw new ToolError('EINVAL', 'command is empty')
  if (input.run_in_background === true || input.runInBackground === true) {
    throw new ToolError('EINVAL', 'background shell is not supported for containerized benchmark bash')
  }

  const cwdInput = typeof input.cwd === 'string' ? input.cwd : undefined
  const cwd = cwdInput ?? ctx.cwd ?? workspaceRoot
  const resolvedCwd = await ctx.sandbox.resolve(cwd, { cwd: ctx.cwd })
  const relCwd = relative(workspaceRoot, resolvedCwd)
  if (relCwd.startsWith('..') || relCwd.split(sep).includes('..')) {
    throw new ToolError('EACCES', 'cwd outside workspace')
  }
  const containerCwd = relCwd ? `/workspace/${relCwd.replaceAll(sep, '/')}` : '/workspace'
  const timeoutMs = bashTimeoutMs(input) ?? 30_000
  const containerName = `agent-runlab-bash-${randomUUID()}`
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  const containerCommand = rewriteHostWorkspacePathForContainer(command, workspaceRoot)
  const args = [
    'run', '--rm', '--network', 'none', '--name', containerName,
    '--user', `${uid}:${gid}`,
    '-v', `${workspaceRoot}:/workspace`,
    '-w', containerCwd,
    image,
    'bash', '-lc', containerCommand,
  ]

  return await new Promise<string>((resolve) => {
    const start = Date.now()
    const chunks: Buffer[] = []
    let bytes = 0
    let killedByTimeout = false
    let killedByAbort = false
    let settled = false

    const settle = (payload: string): void => {
      if (settled) return
      settled = true
      resolve(payload)
    }
    const onData = (buf: Buffer): void => {
      if (bytes >= BASH_OUTPUT_LIMIT) return
      const room = BASH_OUTPUT_LIMIT - bytes
      const slice = buf.length > room ? buf.subarray(0, room) : buf
      chunks.push(slice)
      bytes += slice.length
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      settle(`--- exit code: -1, duration: 0ms\n--- spawn failed: ${msg}`)
      return
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const killContainer = (): void => {
      child.kill('SIGKILL')
      try {
        spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('error', () => {})
      } catch {
        // Ignore best-effort cleanup failure; the caller receives timeout/abort status.
      }
    }
    const timer = setTimeout(() => {
      killedByTimeout = true
      killContainer()
    }, timeoutMs)
    const abortListener = (): void => {
      killedByAbort = true
      killContainer()
    }
    ctx.signal.addEventListener('abort', abortListener, { once: true })
    const cleanup = (): void => {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', abortListener)
    }

    child.on('error', (err) => {
      cleanup()
      const duration = Date.now() - start
      const msg = err instanceof Error ? err.message : String(err)
      settle(`--- exit code: -1, duration: ${duration}ms\n--- spawn failed: ${msg}`)
    })
    child.on('close', (code, signal) => {
      cleanup()
      const duration = Date.now() - start
      const output = Buffer.concat(chunks).toString('utf8')
      const exitLabel = code ?? (signal ? `signal:${signal}` : -1)
      const trailer = killedByTimeout
        ? `\n--- killed after ${timeoutMs}ms (timeout)`
        : killedByAbort
          ? '\n--- aborted'
          : ''
      settle(`${output}--- exit code: ${exitLabel}, duration: ${duration}ms${trailer}`)
    })
  })
}

function bashTimeoutMs(input: Record<string, unknown>): number | undefined {
  const timeoutSeconds = positiveInt(input.timeout_seconds, 1) ?? positiveInt(input.timeoutSeconds, 1)
  if (timeoutSeconds !== undefined) return timeoutSeconds * 1000
  return positiveInt(input.timeout_ms, 100) ?? positiveInt(input.timeoutMs, 100)
}

function positiveInt(value: unknown, min: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < min) return undefined
  return parsed
}

type BuildResult = {
  llm: LLMAdapter
  models: readonly ModelInfo[]
  manualModels: readonly { providerId: string; id: string }[]
  defaultModel: string
}

function createModelRegistry(
  providers: readonly ProviderSpec[],
  initialManualModels: readonly { providerId: string; id: string }[],
  opts: { fallbackDefault: string; maxOutputTokens?: number },
): BuildResult {
  const byPrefix: Array<{ prefix: string; adapter: LLMAdapter }> = []
  const models: ModelInfo[] = []
  let primary: LLMAdapter | undefined
  for (const provider of providers) {
    for (const model of provider.models) {
      const adapter = buildSingleAdapter(provider, model, opts.maxOutputTokens)
      models.push(modelInfo(model, provider.label, {
        providerId: provider.id,
        source: initialManualModels.some((m) => m.providerId === provider.id && m.id === model) ? 'manual' : provider.source,
        ...(provider.contextWindows?.[model] ? { contextWindow: provider.contextWindows[model] } : {}),
      }))
      byPrefix.push({ prefix: model, adapter })
      if (!primary) primary = adapter
    }
  }
  if (!primary) primary = legacyEnvAdapter(models, opts.maxOutputTokens)
  return {
    llm: routerAdapter({ defaultAdapter: primary, byPrefix }),
    models,
    manualModels: initialManualModels,
    defaultModel: process.env.HOST_MODEL ?? opts.fallbackDefault,
  }
}

function buildSingleAdapter(provider: ProviderSpec, model: string, maxOutputTokens?: number): LLMAdapter {
  if (provider.wire === 'anthropic') {
    return anthropicAdapter({
      apiKey: provider.apiKey,
      model,
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
      ...(provider.baseUrl ? { apiUrl: joinPath(provider.baseUrl, '/messages') } : {}),
    })
  }
  return openaiAdapter({
    apiKey: provider.apiKey,
    model,
    ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  })
}

function legacyEnvAdapter(models: ModelInfo[], maxOutputTokens?: number): LLMAdapter {
  const provider = (process.env.AGENT_KERNEL_PROVIDER ?? process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase()
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    const model = process.env.HOST_MODEL ?? 'gpt-4o'
    models.push(modelInfo(model, 'openai (env)', { providerId: 'openai-env', source: 'env' }))
    return openaiAdapter({
      apiKey: process.env.OPENAI_API_KEY,
      model,
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
      ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
    })
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.HOST_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
    models.push(modelInfo(model, 'anthropic (env)', { providerId: 'anthropic-env', source: 'env' }))
    return anthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model,
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
      ...(process.env.ANTHROPIC_BASE_URL ? { apiUrl: joinPath(process.env.ANTHROPIC_BASE_URL, '/messages') } : {}),
    })
  }
  throw new Error('No LLM provider available: configure ~/.claude/settings.json, ~/.codex/config.toml, ANTHROPIC_API_KEY, or OPENAI_API_KEY')
}

function joinPath(base: string, tail: string): string {
  const trimmed = base.replace(/\/+$/, '').replace(/\/messages$/, '')
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${versioned}${tail.startsWith('/') ? tail : `/${tail}`}`
}

function extractLastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

function parseArgs(argv: readonly string[]): Args {
  loadEnvFile(value(argv, '--env-file') ?? defaultBenchmarkEnvPath(REPO_ROOT), { override: true, sourceName: 'env-file' })
  const promptFile = value(argv, '--prompt-file')
  const responseFile = value(argv, '--response-file')
  const sessionLog = value(argv, '--session-log')
  if (!promptFile) throw new Error('missing --prompt-file')
  if (!responseFile) throw new Error('missing --response-file')
  if (!sessionLog) throw new Error('missing --session-log')
  const cwd = value(argv, '--cwd') ?? process.cwd()
  const baseDir = join(homedir(), '.agent-kernel', 'prompt-agent-runlab')
  const systemPromptPreset = value(argv, '--system-prompt-preset') === 'claude-code' ? 'claude-code' : 'codex'
  return {
    promptFile,
    continuationPromptFiles: values(argv, '--continuation-prompt-file'),
    cwd,
    responseFile,
    sessionLog,
    sessionsDir: value(argv, '--sessions-dir') ?? join(baseDir, 'sessions'),
    artifactsDir: value(argv, '--artifacts-dir') ?? join(baseDir, 'artifacts'),
    metadataFile: value(argv, '--metadata-file'),
    model: value(argv, '--model'),
    systemPromptPreset,
    disableWebTools: hasFlag(argv, '--disable-web-tools'),
    bashDockerImage: value(argv, '--bash-docker-image'),
    maxTurns: numberValue(argv, '--max-turns') ?? 40,
    continuationMaxTurns: numberValue(argv, '--continuation-max-turns') ?? numberValue(argv, '--max-turns') ?? 40,
    maxWebToolCalls: numberValue(argv, '--max-web-tool-calls'),
    maxOutputTokens: numberValue(argv, '--max-output-tokens'),
    timeoutMs: numberValue(argv, '--timeout-ms') ?? 30 * 60_000,
    inactivityTimeoutMs: numberValue(argv, '--inactivity-timeout-ms'),
    programbenchCaseJson: value(argv, '--programbench-case-json'),
    programbenchContractContinuationAttempts: numberValue(argv, '--programbench-contract-continuation-attempts', { allowZero: true }) ?? 0,
  }
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
  return out
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

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(new Error(`timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createInactivityWatchdog(timeoutMs: number, onTimeout: () => void): {
  beat(): void
  wrap<T>(promise: Promise<T>): Promise<T>
} {
  let reset: (() => void) | undefined
  return {
    beat() {
      reset?.()
    },
    wrap<T>(promise: Promise<T>) {
      return withInactivityTimeout(promise, timeoutMs, onTimeout, (fn) => { reset = fn }).finally(() => {
        reset = undefined
      })
    },
  }
}

export async function withInactivityTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  onResetReady?: (reset: () => void) => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  let rejectInactive: ((error: Error) => void) | undefined
  const timeout = (): void => {
    if (timedOut) return
    timedOut = true
    onTimeout()
    rejectInactive?.(new Error(`inactive for ${timeoutMs}ms`))
  }
  const reset = (): void => {
    if (timedOut) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(timeout, timeoutMs)
  }
  try {
    reset()
    onResetReady?.(reset)
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        rejectInactive = reject
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readText(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`)
  const { readFile } = await import('node:fs/promises')
  return await readFile(path, 'utf8')
}

if (isMainModule()) {
  main().catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(entry).href : false
}
