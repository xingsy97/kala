#!/usr/bin/env node
/**
 * End-to-end smoke: connect to a running host as a dashboard client, send one
 * user message, print every wire event, exit when the session reaches `done`
 * (or on timeout). Requires host + executor already running.
 *
 * Usage:
 *   node examples/e2e-smoke.mjs [--host http://localhost:3000] \
 *                               [--session demo] \
 *                               [--token AUTH_TOKEN] \
 *                               [--prompt "..."] \
 *                               [--timeout 60]
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Resolve socket.io-client from packages/host/node_modules so this script
// works from anywhere without needing a root-level dependency.
const here = dirname(fileURLToPath(import.meta.url))
const hostPkg = resolve(here, '..', 'packages', 'host', 'package.json')
const requireFromHost = createRequire(hostPkg)
const { io } = requireFromHost('socket.io-client')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    out[a.slice(2)] = argv[++i]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const host = args.host ?? 'http://localhost:3000'
const sessionId = args.session ?? 'smoke'
const prompt = args.prompt ?? 'List the files in the current workspace with the ls tool, then summarize what you find.'
const timeoutSec = Number(args.timeout ?? 60)

const socket = io(`${host}/dashboard`, {
  auth: {
    role: 'dashboard',
    sessionId,
    clientVersion: '0.1.0',
    ...(args.token ? { token: args.token } : {}),
  },
  transports: ['websocket'],
  reconnection: false,
})

const started = Date.now()
let done = false

function log(tag, payload) {
  const ms = ((Date.now() - started) / 1000).toFixed(2)
  const dump = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  console.log(`[+${ms}s] ${tag} ${dump}`)
}

socket.on('connect', () => {
  log('connect', `id=${socket.id}`)
})

socket.on('connect_error', (err) => {
  log('connect_error', err.message)
  process.exit(2)
})

socket.on('session:ready', (p) => {
  log('session:ready', {
    cursor: p.cursor,
    status: p.state.status,
    tools: p.config.tools.map((t) => t.name),
  })
  log('sending prompt', prompt)
  socket.emit('client:user_message', { sessionId, text: prompt })
})

socket.on('event:appended', (p) => {
  log('event:appended', {
    seq: p.seq,
    kind: p.event.kind,
    effects: p.effects.map((e) => e.kind),
  })
})

socket.on('state:changed', (p) => {
  log('state:changed', { cursor: p.cursor, status: p.state.status })
  if (p.state.status === 'done' && !done) {
    done = true
    const last = p.state.messages[p.state.messages.length - 1]
    log('final assistant message', last)
    setTimeout(() => process.exit(0), 250)
  }
  if (p.state.status === 'error' && !done) {
    done = true
    log('agent error', p.state.error ?? '(unknown)')
    setTimeout(() => process.exit(3), 250)
  }
})

socket.on('approval:required', (p) => {
  log('approval:required — auto-approving', p)
  socket.emit('client:user_approve', { sessionId, callId: p.callId })
})

socket.on('session:error', (p) => {
  log('session:error', p)
})

socket.on('usage:updated', (p) => {
  log('usage:updated', p.usage)
})

setTimeout(() => {
  if (!done) {
    log('TIMEOUT', `no terminal state after ${timeoutSec}s`)
    process.exit(4)
  }
}, timeoutSec * 1000)
