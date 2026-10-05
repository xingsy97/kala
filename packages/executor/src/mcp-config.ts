export type DashboardMcpServerConfig = {
  name: string
  command: string
  args: string[]
}

export type McpServerConfig = DashboardMcpServerConfig & {
  env?: Record<string, string>
}

const SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u
const MAX_SERVERS = 16
const MAX_ARGS = 64
const MAX_ENV = 64
const MAX_VALUE_LENGTH = 8_192

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function parseMcpServerConfig(value: unknown, label = 'MCP server'): McpServerConfig {
  const input = record(value, label)
  const allowed = new Set(['name', 'command', 'args', 'env'])
  const unknown = Object.keys(input).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`)
  if (typeof input.name !== 'string' || !SERVER_NAME.test(input.name)) {
    throw new Error(`${label} name must match ${SERVER_NAME}`)
  }
  if (typeof input.command !== 'string' || !input.command || input.command.length > MAX_VALUE_LENGTH || /[\0\r\n]/u.test(input.command)) {
    throw new Error(`${label} command must be a non-empty executable path or name`)
  }
  if (!Array.isArray(input.args) || input.args.length > MAX_ARGS || input.args.some((arg) => typeof arg !== 'string' || arg.length > MAX_VALUE_LENGTH || arg.includes('\0'))) {
    throw new Error(`${label} args must be an array of at most ${MAX_ARGS} strings`)
  }
  let env: Record<string, string> | undefined
  if (input.env !== undefined) {
    const rawEnv = record(input.env, `${label} env`)
    if (Object.keys(rawEnv).length > MAX_ENV || Object.entries(rawEnv).some(([key, item]) => !key || key.includes('=') || key.includes('\0') || typeof item !== 'string' || item.length > MAX_VALUE_LENGTH || item.includes('\0'))) {
      throw new Error(`${label} env must contain at most ${MAX_ENV} valid string entries`)
    }
    env = rawEnv as Record<string, string>
  }
  return { name: input.name, command: input.command, args: [...input.args] as string[], ...(env ? { env: { ...env } } : {}) }
}

export function parseMcpServerDeclaration(json: string, label = '--mcp'): McpServerConfig {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error(`${label} must be valid JSON`) }
  return parseMcpServerConfig(value, label)
}

function parseServerArray<T extends DashboardMcpServerConfig>(
  value: unknown,
  label: string,
  parse: (item: unknown, itemLabel: string) => T,
): T[] {
  if (value === undefined || value === null || value === '') return []
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { throw new Error(`${label} must be valid JSON`) }
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SERVERS) {
    throw new Error(`${label} must be an array of at most ${MAX_SERVERS} servers`)
  }
  const servers = parsed.map((item, index) => parse(item, `${label}[${index}]`))
  const names = new Set<string>()
  for (const server of servers) {
    if (names.has(server.name)) throw new Error(`${label} contains duplicate server name: ${server.name}`)
    names.add(server.name)
  }
  return servers
}

export function parseMcpServers(value: unknown, label = 'MCP_SERVERS'): McpServerConfig[] {
  return parseServerArray(value, label, parseMcpServerConfig)
}

/** Dashboard configuration is deliberately secret-free and rejects `env`. */
export function parseDashboardMcpServers(value: unknown, label = 'Dashboard MCP servers'): DashboardMcpServerConfig[] {
  return parseServerArray(value, label, (item, itemLabel) => {
    const input = record(item, itemLabel)
    const allowed = new Set(['name', 'command', 'args'])
    const unknown = Object.keys(input).find((key) => !allowed.has(key))
    if (unknown) throw new Error(`${itemLabel} contains unknown field: ${unknown}`)
    const parsed = parseMcpServerConfig(input, itemLabel)
    return { name: parsed.name, command: parsed.command, args: parsed.args }
  })
}
