import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import type { RuntimeLogger } from './logger.js'
import type { McpServerConfig } from './mcp-config.js'
import { ToolError, type Tool } from './tools/registry.js'

export type McpToolDescriptor = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schemaHash: string
}

export type McpClientManagerOptions = {
  servers: readonly McpServerConfig[]
  reservedToolNames: ReadonlySet<string>
  initializeTimeoutMs?: number
  callTimeoutMs?: number
  /** Used for Dashboard transactions, where partial catalogs are forbidden. */
  requireAllServers?: boolean
  logger?: Pick<RuntimeLogger, 'info' | 'warn'>
  onCatalogChanged?(tools: readonly Tool[], descriptors: readonly McpToolDescriptor[]): void
}

type ServerState = {
  config: McpServerConfig
  client: Client
  transport: StdioClientTransport
  tools: Tool[]
  descriptors: McpToolDescriptor[]
  available: boolean
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u
const MAX_TOOLS_PER_SERVER = 128
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_SCHEMA_DEPTH = 20
const MAX_DESCRIPTION_BYTES = 4 * 1024
const MAX_RESULT_BYTES = 1024 * 1024
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000

const noopLogger: Pick<RuntimeLogger, 'info' | 'warn'> = { info() {}, warn() {} }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function assertBounded(value: unknown, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('input schema is too deeply nested')
  if (!value || typeof value !== 'object') return
  for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    assertBounded(item, depth + 1)
  }
}

function validateInputSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input schema must be an object')
  const schema = value as Record<string, unknown>
  if (schema.type !== 'object') throw new Error('input schema type must be object')
  assertBounded(schema)
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_SCHEMA_BYTES) throw new Error('input schema is too large')
  return schema
}

function safeDescription(value: unknown): string {
  if (typeof value !== 'string') return 'MCP tool'
  if (Buffer.byteLength(value, 'utf8') > MAX_DESCRIPTION_BYTES) throw new Error('tool description is too large')
  return value
}

function resultText(result: { content?: unknown; isError?: unknown }): string {
  if (!Array.isArray(result.content)) throw new ToolError('EMCP', 'MCP tool returned an invalid content payload')
  const blocks = result.content as Array<{ type?: unknown; text?: unknown }>
  if (blocks.some((block) => block.type !== 'text' || typeof block.text !== 'string')) {
    throw new ToolError('ENOTSUP', 'MCP tool returned unsupported non-text content')
  }
  const text = blocks.map((block) => block.text as string).join('\n')
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new ToolError('EOVERFLOW', 'MCP tool text result exceeds 1 MiB')
  if (result.isError === true) throw new ToolError('EMCP', text || 'MCP tool reported an error')
  return text
}

function callFailure(error: unknown, signal: AbortSignal): ToolError {
  if (signal.aborted) return new ToolError('ECANCELED', 'MCP tool call was cancelled')
  const message = error instanceof Error ? error.message : String(error)
  if (/timed?\s*out|timeout/iu.test(message)) return new ToolError('ETIMEDOUT', 'MCP tool call timed out')
  return new ToolError('EMCP', 'MCP server call failed or the server became unavailable')
}

export class McpClientManager {
  private readonly states: ServerState[] = []
  private readonly processes = new Set<ServerState>()
  private readonly logger: Pick<RuntimeLogger, 'info' | 'warn'>
  private readonly initializeTimeoutMs: number
  private readonly callTimeoutMs: number
  private closing = false
  private initialized = false
  private activeCalls = 0
  private readonly idleWaiters = new Set<() => void>()

  constructor(private readonly options: McpClientManagerOptions) {
    this.logger = options.logger ?? noopLogger
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    const outcomes = await Promise.all(this.options.servers.map(async (config) => {
      try { return await this.initializeServer(config) }
      catch {
        this.logger.warn({ server: config.name }, 'MCP server initialization failed; continuing without its tools')
        return null
      }
    }))

    if (this.options.requireAllServers && outcomes.some((state) => state === null)) {
      await this.close()
      throw new Error('one or more MCP servers failed to initialize')
    }

    const claimed = new Set(this.options.reservedToolNames)
    for (const state of outcomes) {
      if (!state) continue
      const conflict = state.tools.find((tool) => claimed.has(tool.name))
      if (conflict) {
        this.logger.warn({ server: state.config.name, tool: conflict.name }, 'MCP server tool name conflicts with the active catalog; server disabled')
        state.available = false
        await state.client.close().catch(() => undefined)
        this.processes.delete(state)
        if (this.options.requireAllServers) {
          await this.close()
          throw new Error('an MCP server tool conflicts with the active catalog')
        }
        continue
      }
      for (const tool of state.tools) claimed.add(tool.name)
      this.states.push(state)
    }
    this.publish()
  }

  private async initializeServer(config: McpServerConfig): Promise<ServerState> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      ...(config.env ? { env: { ...getDefaultEnvironment(), ...config.env } } : {}),
      stderr: 'ignore',
      maxBufferSize: MAX_RESULT_BYTES + MAX_SCHEMA_BYTES,
    })
    const client = new Client({ name: `kala-executor-${config.name}`, version: '1.0.0' })
    const state: ServerState = { config, client, transport, tools: [], descriptors: [], available: true }
    this.processes.add(state)
    client.onclose = () => this.serverClosed(state)
    try {
      await client.connect(transport, { timeout: this.initializeTimeoutMs })
      const listed = await client.listTools(undefined, { timeout: this.initializeTimeoutMs })
      if (listed.tools.length > MAX_TOOLS_PER_SERVER) throw new Error('too many tools')
      const localNames = new Set<string>()
      for (const remote of listed.tools) {
        const name = `${config.name}__${remote.name}`
        if (!TOOL_NAME.test(name)) throw new Error('invalid prefixed tool name')
        if (localNames.has(name)) throw new Error('duplicate tool name')
        localNames.add(name)
        const inputSchema = validateInputSchema(remote.inputSchema)
        const description = safeDescription(remote.description)
        const schemaHash = createHash('sha256').update(canonicalJson(inputSchema)).digest('hex')
        state.descriptors.push({ name, description, inputSchema, schemaHash })
        state.tools.push({
          name,
          run: async (input, ctx) => {
            if (!state.available) throw new ToolError('EMCP', `MCP server ${config.name} is unavailable`)
            this.activeCalls += 1
            try {
              const result = await client.callTool(
                { name: remote.name, arguments: input },
                undefined,
                { signal: ctx.signal, timeout: this.callTimeoutMs },
              )
              return resultText(result as { content?: unknown; isError?: unknown })
            } catch (error) {
              if (error instanceof ToolError) throw error
              throw callFailure(error, ctx.signal)
            } finally {
              this.activeCalls -= 1
              if (this.activeCalls === 0) {
                for (const resolve of this.idleWaiters) resolve()
                this.idleWaiters.clear()
              }
            }
          },
        })
      }
      this.logger.info({ server: config.name, toolCount: state.tools.length }, 'MCP server initialized')
      return state
    } catch (error) {
      state.available = false
      await client.close().catch(() => transport.close().catch(() => undefined))
      this.processes.delete(state)
      throw error
    }
  }

  private serverClosed(state: ServerState): void {
    if (!state.available) return
    state.available = false
    if (!this.closing) {
      this.logger.warn({ server: state.config.name }, 'MCP server closed; removing its tools')
      this.publish()
    }
  }

  private publish(): void {
    this.options.onCatalogChanged?.(
      this.states.filter((state) => state.available).flatMap((state) => state.tools),
      this.states.filter((state) => state.available).flatMap((state) => state.descriptors),
    )
  }

  descriptors(): readonly McpToolDescriptor[] {
    return this.states.filter((state) => state.available).flatMap((state) => state.descriptors)
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const state of this.processes) state.available = false
    await Promise.allSettled([...this.processes].map((state) => state.client.close()))
    this.states.length = 0
    this.processes.clear()
  }

  /** Stop this manager after calls already dispatched through its catalog settle. */
  async closeWhenIdle(): Promise<void> {
    if (this.activeCalls > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
    }
    await this.close()
  }
}
