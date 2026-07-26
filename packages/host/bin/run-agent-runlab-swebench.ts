#!/usr/bin/env tsx
import { mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { CallToolEffect } from '@agent-kernel/kernel'
import type { ModelInfo } from '@agent-kernel/shared'
import { deriveEvalMemoryPolicy } from '@agent-kernel/shared/enhancement'
import {
  allTools,
  createSandbox,
  createToolRegistry,
  ToolError,
} from '@agent-kernel/executor'
import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import { routerAdapter } from '../src/llm/router.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
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

type Args = {
  promptFile: string
  repo: string
  sessionLog: string
  sessionsDir: string
  artifactsDir: string
  model?: string
  systemPromptPreset: AgentSystemPromptPreset
  maxTurns: number
  timeoutMs: number
}

const logger = createRuntimeLogger('swebench-agent-runlab')
const REPO_ROOT = resolve(process.env.AGENT_RUNLAB_REPO_ROOT?.trim() || process.cwd())

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await mkdir(args.sessionsDir, { recursive: true })
  await mkdir(args.artifactsDir, { recursive: true })

  const prompt = await BunFile.read(args.promptFile)
  const runtime = loadRuntimeConfig()
  const registry = createModelRegistry(runtime.providers, runtime.manualModels, {
    fallbackDefault: runtime.defaultModel,
  })
  const selectedModel = args.model ?? process.env.HOST_MODEL ?? registry.defaultModel
  if (!selectedModel) {
    throw new Error('No model selected. Set --model, HOST_MODEL, or configure a provider default.')
  }
  const resolved = resolveBuiltinAgentModule({
    systemPromptPreset: args.systemPromptPreset,
    ...(knownContextWindow(selectedModel) ? { contextLimit: knownContextWindow(selectedModel) } : {}),
  })
  const store = new SessionStore(args.sessionsDir)
  const sessionId = `swebench-${sanitize(process.env.AGENT_KERNEL_SWEBENCH_INSTANCE_ID ?? 'instance')}-${Date.now()}`
  const record = await store.create({
    sessionId,
    config: resolved.config,
    initialCwd: args.repo,
    initialApprovalMode: 'allow_all',
    memoryPolicy: deriveEvalMemoryPolicy({ benchmarkIsolation: true }),
  })
  const toolDispatcher = createInProcessToolDispatcher(args.repo)
  let llmResponses = 0
  const broadcast: LoopBroadcast = {
    onEvent(_sessionId, seq, event, _effects, state, _llmTrace, model) {
      if (event.kind === 'llm_response') llmResponses += 1
      const payload = {
        seq,
        event: event.kind,
        status: state.status,
        pendingCalls: state.pendingCalls.length,
        ...(model ? { model } : {}),
      }
      process.stderr.write(`[agent-runlab] ${JSON.stringify(payload)}\n`)
    },
    onApprovalRequired(_sessionId, eff) {
      process.stderr.write(`[agent-runlab] unexpected approval request for ${eff.name}:${eff.callId}\n`)
    },
    onError(_sessionId, message) {
      process.stderr.write(`[agent-runlab] error: ${message}\n`)
    },
  }
  const loop = runHostLoop({
    store,
    llm: registry.llm,
    tools: toolDispatcher,
    broadcast,
    models: { get: () => selectedModel },
    artifactRootDir: args.artifactsDir,
  })
  try {
    await withTimeout(
      loop.dispatch(sessionId, { kind: 'user_message', text: prompt }),
      args.timeoutMs,
      () => {
        process.stderr.write(`[agent-runlab] timeout after ${args.timeoutMs}ms; cancelling session ${sessionId}\n`)
        loop.cancelStream(sessionId)
        void loop.dispatch(sessionId, { kind: 'cancel' }).catch(() => {})
      },
    )
  } finally {
    toolDispatcher.cancelPending(sessionId)
  }
  if (llmResponses >= args.maxTurns) {
    process.stderr.write(`[agent-runlab] reached max turns ${args.maxTurns}\n`)
  }
  const finalRecord = store.get(sessionId)
  process.stdout.write(JSON.stringify({
    sessionId,
    sessionLog: record.logPath,
    status: finalRecord?.state.status ?? 'unknown',
    llmResponses,
    model: selectedModel,
    systemPromptPreset: args.systemPromptPreset,
  }, null, 2) + '\n')
  await mkdir(dirname(args.sessionLog), { recursive: true })
  await copyFile(record.logPath, args.sessionLog)
}

function createInProcessToolDispatcher(root: string): ToolDispatcher {
  const sandbox = createSandbox({ roots: [root] })
  const tools = createToolRegistry(allTools)
  const inFlight = new Map<string, AbortController>()
  return {
    async callTool(sessionId: string, eff: CallToolEffect) {
      const tool = tools.get(eff.name)
      if (!tool) return { ok: false, content: `ERROR: unknown tool: ${eff.name}` }
      const controller = new AbortController()
      inFlight.set(eff.callId, controller)
      try {
        const content = await tool.run(eff.input, {
          sessionId,
          sandbox,
          signal: controller.signal,
          ...(eff.cwd ? { cwd: eff.cwd } : {}),
        })
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
  }
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
  opts: { fallbackDefault: string },
): BuildResult {
  const byPrefix: Array<{ prefix: string; adapter: LLMAdapter }> = []
  const models: ModelInfo[] = []
  let primary: LLMAdapter | undefined
  for (const provider of providers) {
    for (const model of provider.models) {
      const adapter = buildSingleAdapter(provider, model)
      models.push(modelInfo(model, provider.label, {
        providerId: provider.id,
        source: initialManualModels.some((m) => m.providerId === provider.id && m.id === model) ? 'manual' : provider.source,
        ...(provider.contextWindows?.[model] ? { contextWindow: provider.contextWindows[model] } : {}),
      }))
      byPrefix.push({ prefix: model, adapter })
      if (!primary) primary = adapter
    }
  }
  if (!primary) primary = legacyEnvAdapter(models)
  return {
    llm: routerAdapter({ defaultAdapter: primary, byPrefix }),
    models,
    manualModels: initialManualModels,
    defaultModel: process.env.HOST_MODEL ?? opts.fallbackDefault,
  }
}

function buildSingleAdapter(provider: ProviderSpec, model: string): LLMAdapter {
  if (provider.wire === 'anthropic') {
    return anthropicAdapter({
      apiKey: provider.apiKey,
      model,
      ...(provider.baseUrl ? { apiUrl: joinPath(provider.baseUrl, '/messages') } : {}),
    })
  }
  return openaiAdapter({
    apiKey: provider.apiKey,
    model,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  })
}

function legacyEnvAdapter(models: ModelInfo[]): LLMAdapter {
  const provider = (process.env.AGENT_KERNEL_PROVIDER ?? process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase()
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    const model = process.env.HOST_MODEL ?? 'gpt-4o'
    models.push(modelInfo(model, 'openai (env)', { providerId: 'openai-env', source: 'env' }))
    return openaiAdapter({
      apiKey: process.env.OPENAI_API_KEY,
      model,
      ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
    })
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.HOST_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
    models.push(modelInfo(model, 'anthropic (env)', { providerId: 'anthropic-env', source: 'env' }))
    return anthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model,
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

function parseArgs(argv: readonly string[]): Args {
  loadEnvFile(value(argv, '--env-file') ?? defaultBenchmarkEnvPath(REPO_ROOT), { override: true, sourceName: 'env-file' })
  const promptFile = value(argv, '--prompt-file') ?? process.env.AGENT_KERNEL_SWEBENCH_PROMPT_FILE
  const repo = value(argv, '--repo') ?? process.env.AGENT_KERNEL_SWEBENCH_REPO ?? process.cwd()
  const sessionLog = value(argv, '--session-log') ?? process.env.AGENT_KERNEL_SWEBENCH_SESSION_LOG
  if (!promptFile) throw new Error('missing --prompt-file or AGENT_KERNEL_SWEBENCH_PROMPT_FILE')
  if (!sessionLog) throw new Error('missing --session-log or AGENT_KERNEL_SWEBENCH_SESSION_LOG')
  const baseDir = join(homedir(), '.agent-kernel', 'swebench-agent-runlab')
  const systemPromptPreset = value(argv, '--system-prompt-preset') === 'claude-code' ? 'claude-code' : 'codex'
  return {
    promptFile,
    repo,
    sessionLog,
    sessionsDir: value(argv, '--sessions-dir') ?? join(baseDir, 'sessions'),
    artifactsDir: value(argv, '--artifacts-dir') ?? join(baseDir, 'artifacts'),
    model: value(argv, '--model'),
    systemPromptPreset,
    maxTurns: numberValue(argv, '--max-turns') ?? 40,
    timeoutMs: numberValue(argv, '--timeout-ms') ?? 30 * 60_000,
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

function numberValue(argv: readonly string[], name: string): number | undefined {
  const raw = value(argv, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
  return n
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

const BunFile = {
  async read(path: string): Promise<string> {
    if (!existsSync(path)) throw new Error(`file not found: ${path}`)
    const { readFile } = await import('node:fs/promises')
    return await readFile(path, 'utf8')
  },
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
