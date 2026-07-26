#!/usr/bin/env tsx
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import { createRuntimeLogger } from '../src/logger.js'
import { defaultBenchmarkEnvPath, loadAnthropicCliDefaults, loadEnvFile, requireAnthropicBaseUrl } from '../src/runtime-config.js'

type Args = {
  promptFile: string
  repo: string
  artifactsDir: string
  model: string
  smallFastModel: string
  baseUrl: string
  maxTurns: number
  timeoutMs: number
}

const logger = createRuntimeLogger('swebench-claude-code')
const REPO_ROOT = resolve(process.env.AGENT_RUNLAB_REPO_ROOT?.trim() || process.cwd())

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const sdkBaseUrl = normalizeClaudeCodeBaseUrl(args.baseUrl)
  await mkdir(args.artifactsDir, { recursive: true })
  const prompt = await readFile(args.promptFile, 'utf8')
  const apiKey = resolveAnthropicApiKey()
  const debugFile = join(args.artifactsDir, 'claude-agent-sdk.debug.log')
  const transcriptPath = join(args.artifactsDir, 'claude-agent-sdk.messages.jsonl')
  const resultPath = join(args.artifactsDir, 'claude-agent-sdk.result.json')
  const abortController = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, args.timeoutMs)

  const messages: SDKMessage[] = []
  let result: SDKMessage | undefined
  try {
    const stream = query({
      prompt,
      options: {
        cwd: args.repo,
        model: args.model,
        maxTurns: args.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        debug: true,
        debugFile,
        settingSources: [],
        settings: {
          env: {
            ANTHROPIC_BASE_URL: sdkBaseUrl,
            ANTHROPIC_MODEL: args.model,
            ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
          },
        },
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: apiKey,
          ANTHROPIC_BASE_URL: sdkBaseUrl,
          ANTHROPIC_MODEL: args.model,
          ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        },
        abortController,
      },
    })
    for await (const message of stream) {
      messages.push(message)
      await appendJsonl(transcriptPath, redactMessage(message, apiKey))
      process.stderr.write(`[claude-code] ${JSON.stringify(summarizeMessage(message))}\n`)
      if (message.type === 'result') result = message
    }
  } finally {
    clearTimeout(timer)
  }

  const redactedResult = {
    model: args.model,
    baseUrl: sdkBaseUrl,
    maxTurns: args.maxTurns,
    timeoutMs: args.timeoutMs,
    timedOut,
    messageCount: messages.length,
    result: result ? redactMessage(result, apiKey) : null,
  }
  await writeFile(resultPath, `${JSON.stringify(redactedResult, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(redactedResult, null, 2)}\n`)

  if (timedOut) {
    throw new Error(`Claude Code SDK timed out after ${args.timeoutMs}ms`)
  }
  if (!result || result.type !== 'result' || result.subtype !== 'success' || sdkResultIsError(result)) {
    throw new Error(`Claude Code SDK did not finish successfully: ${result ? JSON.stringify(summarizeMessage(result)) : 'missing result'}`)
  }
}

function normalizeClaudeCodeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/v\d+$/, '')
}

function sdkResultIsError(message: SDKMessage): boolean {
  if (message.type !== 'result') return false
  const record = message as unknown as Record<string, unknown>
  if (record.is_error === true) return true
  if (record.api_error_status !== undefined && record.api_error_status !== null) return true
  if (record.terminal_reason === 'api_error') return true
  const errors = record.errors
  return Array.isArray(errors) && errors.length > 0
}

function resolveAnthropicApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const settingsPath = join(process.env.HOME ?? '', '.claude', 'settings.json')
  if (!existsSync(settingsPath)) throw new Error('ANTHROPIC_API_KEY is unset and ~/.claude/settings.json was not found')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { apiKeyHelper?: string }
  if (!settings.apiKeyHelper) throw new Error('ANTHROPIC_API_KEY is unset and ~/.claude/settings.json has no apiKeyHelper')
  return execSync(settings.apiKeyHelper, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' })
}

function summarizeMessage(message: SDKMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { type: message.type }
  if ('subtype' in message) out.subtype = message.subtype
  if ('error' in message && message.error) out.error = message.error
  if (message.type === 'assistant') {
    out.blocks = message.message.content.map((block) => block.type)
  }
  if (message.type === 'result') {
    out.durationMs = message.duration_ms
    out.totalCostUsd = message.total_cost_usd
  }
  return out
}

function redactMessage(message: SDKMessage, apiKey: string): unknown {
  const raw = JSON.stringify(message)
  return JSON.parse(raw.replaceAll(apiKey, '[REDACTED_API_KEY]'))
}

function parseArgs(argv: readonly string[]): Args {
  loadEnvFile(value(argv, '--env-file') ?? defaultBenchmarkEnvPath(REPO_ROOT), { override: true, sourceName: 'env-file' })
  const anthropicDefaults = loadAnthropicCliDefaults()
  const baseUrl = requireAnthropicBaseUrl({ explicit: value(argv, '--base-url'), defaults: anthropicDefaults })
  const promptFile = value(argv, '--prompt-file') ?? process.env.AGENT_KERNEL_SWEBENCH_PROMPT_FILE
  const repo = value(argv, '--repo') ?? process.env.AGENT_KERNEL_SWEBENCH_REPO ?? process.cwd()
  if (!promptFile) throw new Error('missing --prompt-file or AGENT_KERNEL_SWEBENCH_PROMPT_FILE')
  return {
    promptFile,
    repo,
    artifactsDir: value(argv, '--artifacts-dir') ?? join(repo, '.claude-code-swebench-artifacts'),
    model: value(argv, '--model') ?? anthropicDefaults.model ?? 'claude-sonnet-4-6',
    smallFastModel: value(argv, '--small-fast-model') ?? anthropicDefaults.smallFastModel ?? 'claude-haiku-4-5',
    baseUrl: baseUrl.baseUrl,
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

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
