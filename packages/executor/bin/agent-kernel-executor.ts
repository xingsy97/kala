#!/usr/bin/env node
/**
 * `agent-kernel-executor` CLI.
 *
 * Reads:
 *   HOST_URL        -  required (e.g. http://localhost:3000)
 *   SESSION_ID      -  required
 *   WORKSPACE       -  required; absolute path or `:`-separated list
 *   EXECUTOR_TOKEN  -  optional; must match host's HOST_AUTH_TOKEN if set
 *   EXECUTOR_ID     -  optional; defaults to a ULID
 *
 * Also accepts `--host`, `--session`, `--workspace`, `--token`, `--id` overrides.
 */

import process from 'node:process'

import { startExecutor } from '../src/client.js'

type Args = {
  host?: string
  session?: string
  workspace?: string
  token?: string
  id?: string
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const eq = a.indexOf('=')
    const [key, inline] =
      eq === -1 ? [a, undefined] : [a.slice(0, eq), a.slice(eq + 1)]
    const value = inline ?? argv[++i]
    if (value === undefined) continue
    switch (key) {
      case '--host':
        out.host = value
        break
      case '--session':
        out.session = value
        break
      case '--workspace':
        out.workspace = value
        break
      case '--token':
        out.token = value
        break
      case '--id':
        out.id = value
        break
      default:
        break
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const host = args.host ?? process.env.HOST_URL
  const session = args.session ?? process.env.SESSION_ID
  const workspaceRaw = args.workspace ?? process.env.WORKSPACE
  const token = args.token ?? process.env.EXECUTOR_TOKEN
  const executorId = args.id ?? process.env.EXECUTOR_ID

  if (!host || !session || !workspaceRaw) {
    console.error(
      'usage: agent-kernel-executor --host <url> --session <id> --workspace <path>',
    )
    console.error('or set HOST_URL / SESSION_ID / WORKSPACE env vars')
    process.exit(1)
  }
  const workspace = workspaceRaw.split(':').filter((s) => s.length > 0)

  const handle = startExecutor({
    host,
    sessionId: session,
    workspace,
    ...(token !== undefined ? { token } : {}),
    ...(executorId !== undefined ? { executorId } : {}),
  })

  handle.socket.on('connect', () => {
    console.log(
      `executor ${handle.executorId} connected to ${host} for session ${session}`,
    )
  })
  handle.socket.on('disconnect', (reason) => {
    console.log(`executor disconnected: ${reason}`)
  })
  handle.socket.on('session:error', (e) => {
    console.error(`[${e.scope}] ${e.message}`)
  })

  await handle.ready
  console.log('executor announced; awaiting tool calls...')

  const shutdown = (): void => {
    console.log('shutting down...')
    handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
