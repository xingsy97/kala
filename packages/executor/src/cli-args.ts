export type ServiceAction = 'install' | 'status' | 'logs' | 'restart' | 'uninstall'
export type ServiceMode = 'system' | 'user'

export type ExecutorCliArgs = {
  command: 'run' | 'service' | 'internal-installer'
  serviceAction?: ServiceAction
  serviceMode?: ServiceMode
  installerSession?: string
  help?: boolean
  version?: boolean
  host?: string
  name?: string
  sandboxRoots: string[]
  token?: string
  invite?: string
  id?: string
  profile?: string
  autoUpdate?: boolean
  noUpdateCheck?: boolean
  updateRepo?: string
}

const SERVICE_ACTIONS = new Set<ServiceAction>(['install', 'status', 'logs', 'restart', 'uninstall'])

/** Parses both the historical daemon flags and the runlab-executor service surface. */
export function parseExecutorCliArgs(argv: readonly string[]): ExecutorCliArgs {
  const out: ExecutorCliArgs = { command: 'run', sandboxRoots: [] }
  let start = 0
  if (argv[0] === 'service') {
    const action = argv[1]
    if (!action || !SERVICE_ACTIONS.has(action as ServiceAction)) {
      throw new Error(`Unknown service action: ${action ?? '<missing>'}`)
    }
    out.command = 'service'
    out.serviceAction = action as ServiceAction
    start = 2
  }

  for (let i = start; i < argv.length; i++) {
    const argument = argv[i]!
    if (argument === '--') continue
    const equal = argument.indexOf('=')
    const key = equal === -1 ? argument : argument.slice(0, equal)
    const inline = equal === -1 ? undefined : argument.slice(equal + 1)
    const value = (): string => {
      const next = inline ?? argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${key}`)
      return next
    }

    switch (key) {
      case '--internal-installer':
        out.command = 'internal-installer'
        out.installerSession = value()
        break
      case '--system': out.serviceMode = 'system'; break
      case '--user': out.serviceMode = 'user'; break
      case '--auto-update': out.autoUpdate = true; break
      case '-h': case '--help': out.help = true; break
      case '-v': case '--version': out.version = true; break
      case '--no-update-check': out.noUpdateCheck = true; break
      case '--host': out.host = value(); break
      case '--name': out.name = value(); break
      case '--sandbox-root': out.sandboxRoots.push(value()); break
      case '--token': out.token = value(); break
      case '--invite': out.invite = value(); break
      case '--id': out.id = value(); break
      case '--profile': out.profile = value(); break
      case '--update-repo': out.updateRepo = value(); break
      default:
        // Historical CLI silently ignored unknown arguments. Preserve that behavior.
        break
    }
  }
  if (out.command === 'service' && !out.serviceMode) out.serviceMode = 'user'
  return out
}
