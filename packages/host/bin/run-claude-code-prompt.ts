#!/usr/bin/env tsx
import { execSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createSdkMcpServer, query, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'

import { createRuntimeLogger } from '../src/logger.js'
import { defaultBenchmarkEnvPath, loadAnthropicCliDefaults, loadEnvFile, requireAnthropicBaseUrl } from '../src/runtime-config.js'

type Args = {
  promptFile: string
  cwd: string
  artifactsDir: string
  responseFile: string
  model: string
  smallFastModel: string
  baseUrl: string
  disableWebTools: boolean
  sharedWebTools: boolean
  sandboxCommands: boolean
  bashDockerImage?: string
  maxTurns: number
  timeoutMs: number
  inactivityTimeoutMs?: number
}

const CLAUDE_CODE_WEB_TOOLS = ['WebSearch', 'WebFetch']
const BASH_OUTPUT_LIMIT = 1_000_000

const logger = createRuntimeLogger('prompt-claude-code')
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const sdkBaseUrl = normalizeClaudeCodeBaseUrl(args.baseUrl)
  await mkdir(args.artifactsDir, { recursive: true })
  await mkdir(dirname(args.responseFile), { recursive: true })
  const isolatedHome = join(args.cwd, '.claude-home')
  await mkdir(isolatedHome, { recursive: true })
  const helperBinDir = join(args.cwd, '.benchmark-bin')
  const helperPath = args.sharedWebTools ? await writeBenchmarkWebHelper(helperBinDir) : undefined
  const prompt = withDockerBashInstructions(
    withSharedWebInstructions(await readFile(args.promptFile, 'utf8'), args.sharedWebTools),
    args,
  )
  const apiKey = resolveAnthropicApiKey()
  const mcpServers = args.bashDockerImage ? {
    programbench: createProgramBenchMcpServer(args.cwd, args.bashDockerImage),
  } : undefined
  const debugFile = join(args.artifactsDir, 'claude-agent-sdk.debug.log')
  const transcriptPath = join(args.artifactsDir, 'claude-agent-sdk.messages.jsonl')
  const resultPath = join(args.artifactsDir, 'claude-agent-sdk.result.json')
  const abortController = new AbortController()
  let timedOut = false
  let inactivityTimedOut = false
  let lastMessageAt = Date.now()
  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, args.timeoutMs)
  const inactivityTimer = args.inactivityTimeoutMs !== undefined
    ? setInterval(() => {
        const idleMs = Date.now() - lastMessageAt
        if (idleMs < (args.inactivityTimeoutMs ?? 0)) return
        inactivityTimedOut = true
        abortController.abort()
      }, Math.min(5000, Math.max(1000, Math.floor(args.inactivityTimeoutMs / 4))))
    : undefined
  inactivityTimer?.unref?.()

  const messages: SDKMessage[] = []
  let result: SDKMessage | undefined
  let streamError: string | null = null
  try {
    const stream = query({
      prompt,
      options: {
        cwd: args.cwd,
        model: args.model,
        maxTurns: args.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        debug: true,
        debugFile,
        ...(args.disableWebTools || args.sharedWebTools ? { disallowedTools: CLAUDE_CODE_WEB_TOOLS } : {}),
        ...(mcpServers ? {
          mcpServers,
          strictMcpConfig: true,
          toolAliases: { Bash: 'mcp__programbench__programbench_bash' },
        } : {}),
        ...(args.sandboxCommands ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            enableWeakerNestedSandbox: true,
            network: {
              allowedDomains: [],
              deniedDomains: ['*'],
              allowLocalBinding: false,
              allowAllUnixSockets: false,
            },
            filesystem: {
              allowRead: [args.cwd],
              allowWrite: [args.cwd],
            },
            credentials: {
              envVars: [
                { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
                { name: 'OPENAI_API_KEY', mode: 'deny' },
                { name: 'SERPER_API_KEY', mode: 'deny' },
              ],
            },
          },
        } : {}),
        settingSources: [],
        settings: {
          env: {
            ANTHROPIC_BASE_URL: sdkBaseUrl,
            ANTHROPIC_MODEL: args.model,
            ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
            HOME: isolatedHome,
            AGENT_KERNEL_WORKSPACE: args.cwd,
            ...(helperPath ? { PATH: `${helperBinDir}:${process.env.PATH ?? ''}` } : {}),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
          },
        },
        env: {
          ...process.env,
          HOME: isolatedHome,
          AGENT_KERNEL_WORKSPACE: args.cwd,
          ANTHROPIC_API_KEY: apiKey,
          ANTHROPIC_BASE_URL: sdkBaseUrl,
          ANTHROPIC_MODEL: args.model,
          ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
          ...(helperPath ? { PATH: `${helperBinDir}:${process.env.PATH ?? ''}` } : {}),
          ...(process.env.SERPER_API_KEY ? { SERPER_API_KEY: process.env.SERPER_API_KEY } : {}),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        },
        abortController,
      },
    })
    for await (const message of stream) {
      lastMessageAt = Date.now()
      messages.push(message)
      await appendJsonl(transcriptPath, redactMessage(message, apiKey))
      process.stderr.write(`[claude-code] ${JSON.stringify(summarizeMessage(message))}\n`)
      if (message.type === 'result') {
        result = message
        abortController.abort()
        break
      }
    }
  } catch (err: unknown) {
    streamError = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
    if (inactivityTimer) clearInterval(inactivityTimer)
  }

  const responseText = extractLastAssistantText(messages)
  await writeFile(args.responseFile, responseText, 'utf8')
  const redactedResult = {
    model: args.model,
    baseUrl: sdkBaseUrl,
    maxTurns: args.maxTurns,
    timeoutMs: args.timeoutMs,
    inactivityTimeoutMs: args.inactivityTimeoutMs,
    disabledTools: args.disableWebTools || args.sharedWebTools ? CLAUDE_CODE_WEB_TOOLS : [],
    sharedWebTools: args.sharedWebTools,
    sandboxCommands: args.sandboxCommands,
    sandboxMode: args.bashDockerImage ? 'docker_network_none_mcp_bash' : args.sandboxCommands ? 'claude_code_sdk_sandbox_nested' : 'disabled',
    bashDockerImage: args.bashDockerImage,
    benchmarkWebHelper: helperPath,
    timedOut,
    inactivityTimedOut,
    lastMessageAt,
    error: streamError,
    messageCount: messages.length,
    responseFile: args.responseFile,
    isolatedHome,
    result: result ? redactMessage(result, apiKey) : null,
  }
  await writeFile(resultPath, `${JSON.stringify(redactedResult, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(redactedResult, null, 2)}\n`)

  if (streamError) throw new Error(streamError)
  if (timedOut) throw new Error(`Claude Code SDK timed out after ${args.timeoutMs}ms`)
  if (inactivityTimedOut) throw new Error(`Claude Code SDK produced no messages for ${args.inactivityTimeoutMs}ms`)
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

async function writeBenchmarkWebHelper(binDir: string): Promise<string> {
  await mkdir(binDir, { recursive: true })
  const helperPath = join(binDir, 'benchmark-web')
  const pnpmPath = resolvePnpmPath()
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `export COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
    `exec ${JSON.stringify(pnpmPath)} --dir ${JSON.stringify(process.cwd())} --filter @agent-kernel/host exec tsx bin/run-benchmark-web.ts "$@"`,
    '',
  ].join('\n')
  await writeFile(helperPath, script, 'utf8')
  await chmod(helperPath, 0o755)
  return helperPath
}

function createProgramBenchMcpServer(workspaceRoot: string, image: string) {
  return createSdkMcpServer({
    name: 'programbench',
    version: '1.0.0',
    instructions: `ProgramBench shell commands are executed inside the benchmark clean-room Docker image with network disabled and only the task workspace mounted at /workspace. Claude Code file tools run on the host workspace, not inside Docker; use /workspace only inside shell commands.`,
    alwaysLoad: true,
    tools: [
      tool(
        'programbench_bash',
        'Run a shell command inside the ProgramBench clean-room Docker image with --network none and the task workspace mounted at /workspace. The /workspace path is valid inside this shell only; Claude Code Write/Edit/Read tools should use the host workspace path or relative paths.',
        {
          command: z.string(),
          description: z.string().optional(),
          cwd: z.string().optional(),
          timeout_seconds: z.number().int().positive().optional(),
          timeoutSeconds: z.number().int().positive().optional(),
          timeout_ms: z.number().int().positive().optional(),
          timeoutMs: z.number().int().positive().optional(),
        },
        async (input) => ({
          content: [{ type: 'text', text: await runDockerBash(input, workspaceRoot, image) }],
        }),
        { alwaysLoad: true },
      ),
    ],
  })
}

async function runDockerBash(input: Record<string, unknown>, workspaceRoot: string, image: string): Promise<string> {
  const command = typeof input.command === 'string' ? input.command : ''
  if (command.trim().length === 0) return 'ERROR: command is empty'
  const cwdInput = typeof input.cwd === 'string' ? input.cwd : workspaceRoot
  const resolvedCwd = resolveDockerCwd(cwdInput, workspaceRoot)
  const relCwd = relative(workspaceRoot, resolvedCwd)
  if (relCwd.startsWith('..') || relCwd.split(sep).includes('..')) return 'ERROR: cwd outside workspace'
  const containerCwd = relCwd ? `/workspace/${relCwd.replaceAll(sep, '/')}` : '/workspace'
  const timeoutMs = bashTimeoutMs(input) ?? 30_000
  const containerName = `claude-programbench-bash-${randomUUID()}`
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  const args = [
    'run', '--rm', '--network', 'none', '--name', containerName,
    '--user', `${uid}:${gid}`,
    '-v', `${workspaceRoot}:/workspace`,
    '-w', containerCwd,
    image,
    'bash', '-lc', command,
  ]
  return await new Promise((resolve) => {
    const start = Date.now()
    const chunks: Buffer[] = []
    let bytes = 0
    let killedByTimeout = false
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (buf: Buffer): void => {
      if (bytes >= BASH_OUTPUT_LIMIT) return
      const room = BASH_OUTPUT_LIMIT - bytes
      const slice = buf.length > room ? buf.subarray(0, room) : buf
      chunks.push(slice)
      bytes += slice.length
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const timer = setTimeout(() => {
      killedByTimeout = true
      child.kill('SIGKILL')
      try {
        spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('error', () => {})
      } catch {
        // Best-effort cleanup only.
      }
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      const msg = err instanceof Error ? err.message : String(err)
      resolve(`--- exit code: -1, duration: ${Date.now() - start}ms\n--- spawn failed: ${msg}`)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const output = Buffer.concat(chunks).toString('utf8')
      const exitLabel = code ?? (signal ? `signal:${signal}` : -1)
      const trailer = killedByTimeout ? `\n--- killed after ${timeoutMs}ms (timeout)` : ''
      resolve(`${output}--- exit code: ${exitLabel}, duration: ${Date.now() - start}ms${trailer}`)
    })
  })
}

function resolveDockerCwd(cwdInput: string, workspaceRoot: string): string {
  if (cwdInput === '/workspace') return workspaceRoot
  if (cwdInput.startsWith('/workspace/')) return join(workspaceRoot, cwdInput.slice('/workspace/'.length))
  return cwdInput.startsWith('/') ? cwdInput : join(workspaceRoot, cwdInput)
}

function bashTimeoutMs(input: Record<string, unknown>): number | undefined {
  const timeoutSeconds = positiveInt(input.timeout_seconds) ?? positiveInt(input.timeoutSeconds)
  if (timeoutSeconds !== undefined) return timeoutSeconds * 1000
  return positiveInt(input.timeout_ms) ?? positiveInt(input.timeoutMs)
}

function positiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

function resolvePnpmPath(): string {
  return execSync('command -v pnpm', { encoding: 'utf8', shell: '/bin/bash' }).trim()
}

function withSharedWebInstructions(prompt: string, enabled: boolean): string {
  if (!enabled) return prompt
  return `${SHARED_WEB_INSTRUCTIONS}\n\n${prompt}`
}

function withDockerBashInstructions(prompt: string, args: Args): string {
  if (!args.bashDockerImage) return prompt
  return `${DOCKER_BASH_WORKSPACE_INSTRUCTIONS(args.cwd)}\n\n${prompt}`
}

function DOCKER_BASH_WORKSPACE_INSTRUCTIONS(workspaceRoot: string): string {
  return `
ProgramBench workspace path rules for this run:

- Claude Code file tools such as Read, Write, and Edit run on the host workspace.
- The host workspace is: ${workspaceRoot}
- When creating or editing files with Claude Code file tools, use relative paths from the current working directory or paths under the host workspace above.
- Do not use /workspace with Claude Code Read, Write, or Edit tools.
- Bash commands run through the benchmark shell are executed inside Docker, where the same task workspace is mounted at /workspace.
- Use /workspace only inside shell commands passed to Bash.
- If you delegate to a subagent, tell it to write files in the current working directory or under the host workspace, not under /workspace unless it is using Bash.
`.trim()
}

const SHARED_WEB_INSTRUCTIONS = `
Benchmark web access is provided through the local command \`benchmark-web\`. Do not use Claude Code WebSearch or WebFetch for this run.

Use these commands through Bash when web evidence is needed:

\`benchmark-web search --query "search terms" --limit 5\`
\`benchmark-web fetch --url "https://example.com/page" --max-chars 12000\`

This helper uses the benchmark harness web stack, so its results are the intended source of web evidence for this comparison.
`.trim()

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

function extractLastAssistantText(messages: readonly SDKMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'assistant') continue
    const blocks = message.message.content as unknown as Array<Record<string, unknown>>
    const text = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

function parseArgs(argv: readonly string[]): Args {
  loadEnvFile(value(argv, '--env-file') ?? defaultBenchmarkEnvPath(REPO_ROOT), { override: true, sourceName: 'env-file' })
  const anthropicDefaults = loadAnthropicCliDefaults()
  const baseUrl = requireAnthropicBaseUrl({ explicit: value(argv, '--base-url'), defaults: anthropicDefaults })
  const promptFile = value(argv, '--prompt-file')
  const responseFile = value(argv, '--response-file')
  if (!promptFile) throw new Error('missing --prompt-file')
  if (!responseFile) throw new Error('missing --response-file')
  const cwd = value(argv, '--cwd') ?? process.cwd()
  return {
    promptFile,
    cwd,
    responseFile,
    artifactsDir: value(argv, '--artifacts-dir') ?? join(cwd, '.claude-code-prompt-artifacts'),
    model: value(argv, '--model') ?? anthropicDefaults.model ?? 'claude-sonnet-4-6',
    smallFastModel: value(argv, '--small-fast-model') ?? anthropicDefaults.smallFastModel ?? 'claude-haiku-4-5',
    baseUrl: baseUrl.baseUrl,
    disableWebTools: hasFlag(argv, '--disable-web-tools'),
    sharedWebTools: hasFlag(argv, '--shared-web-tools'),
    sandboxCommands: hasFlag(argv, '--sandbox-commands'),
    bashDockerImage: value(argv, '--bash-docker-image'),
    maxTurns: numberValue(argv, '--max-turns') ?? 40,
    timeoutMs: numberValue(argv, '--timeout-ms') ?? 30 * 60_000,
    inactivityTimeoutMs: numberValue(argv, '--inactivity-timeout-ms'),
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

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
