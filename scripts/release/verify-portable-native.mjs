#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { io } from 'socket.io-client'
import { createRcEvidence } from './rc-evidence.mjs'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const asset = resolve(required('--asset'))
const predecessorAsset = option('--predecessor-asset') ? resolve(option('--predecessor-asset')) : asset
const target = required('--target')
const tag = required('--tag')
const revision = required('--revision')
const output = resolve(required('--output'))
if (!existsSync(asset)) throw new Error('Portable native asset is missing')
if (!existsSync(predecessorAsset)) throw new Error('Portable predecessor native asset is missing')
const scratch = mkdtempSync(join(tmpdir(), 'runlab-portable-acceptance-'))
const install = join(scratch, process.platform === 'win32' ? 'agent-runlab.exe' : 'agent-runlab')
const state = join(scratch, 'state')
const sessions = join(state, 'sessions')
const artifacts = join(state, 'artifacts')
const sessionId = 'portable-acceptance-' + randomUUID()
mkdirSync(sessions, { recursive: true })
mkdirSync(artifacts, { recursive: true })
copyFileSync(predecessorAsset, install)
if (process.platform !== 'win32') chmodSync(install, 0o755)
let running

try {
  const first = await startPortable()
  const capabilities = await fetch(first.origin + '/runtime/capabilities').then(assertOkJson)
  if (capabilities.product !== 'portable' || capabilities.deployment?.architecture !== 'portable') throw new Error('native asset did not start in Portable mode')
  const dashboard = await fetch(first.origin + '/')
  if (!dashboard.ok || !(await dashboard.text()).includes('<html')) throw new Error('native asset did not serve its embedded Dashboard')
  const socket = await connect(first.origin)
  const created = await emitAck(socket, 'client:create_session', { operationId: 'operation-' + randomUUID(), sessionId })
  if (!created.ok) throw new Error('Portable Session creation failed: ' + String(created.error))
  const listed = await listSessions(socket)
  if (!listed.sessions.some((entry) => entry.sessionId === sessionId)) throw new Error('created Portable Session was not listed')
  socket.close()
  await stopPortable(first.origin)

  const replacement = install + '.next'
  copyFileSync(asset, replacement)
  if (process.platform !== 'win32') chmodSync(replacement, 0o755)
  renameSync(replacement, install)
  const second = await startPortable()
  const restarted = await connect(second.origin)
  const afterRestart = await listSessions(restarted)
  if (!afterRestart.sessions.some((entry) => entry.sessionId === sessionId)) throw new Error('Portable Session state did not survive binary replacement and restart')
  restarted.close()
  await stopPortable(second.origin)

  const evidence = createRcEvidence({
    category: 'portable', target, tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: basename(asset), sha256: createHash('sha256').update(readFileSync(asset)).digest('hex') },
    checks: { assetIntegrity: true, cleanInstall: true, boot: true, capabilities: true, dashboard: true, statePersistence: true, cleanStop: true, upgrade: true },
  })
  mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, category: 'portable', target, evidence: basename(output) }) + '\n')
} finally {
  if (running) await stopPortable().catch(() => undefined)
  rmSync(scratch, { recursive: true, force: true })
}

async function startPortable() {
  const port = await freePort()
  const logs = []
  const child = spawn(install, [], {
    cwd: scratch,
    env: { ...process.env, HOST_LISTEN_HOST: '127.0.0.1', HOST_PORT: String(port), AGENT_KERNEL_STATE_DIR: state, SESSIONS_DIR: sessions, AGENT_KERNEL_ARTIFACTS_DIR: artifacts, ANTHROPIC_API_KEY: 'acceptance-key-not-used' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  running = { child, exit, logs }
  const origin = 'http://127.0.0.1:' + port
  try { await waitForHttp(origin + '/runtime/capabilities', 20_000) } catch (error) { throw new Error(String(error) + '\n' + logs.join('').slice(-2000)) }
  return { origin }
}

async function stopPortable(origin) {
  const processState = running
  if (!processState) return
  if (!origin) processState.child.kill('SIGTERM')
  else {
    const response = await fetch(origin + '/runtime/restart', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'checkpoint', reason: 'manual', timeoutMs: 10_000 }),
    })
    if (!response.ok) throw new Error('Portable graceful stop request failed: HTTP ' + response.status)
  }
  const exit = await Promise.race([processState.exit, delay(10_000).then(() => null)])
  running = undefined
  if (!exit) { processState.child.kill('SIGKILL'); throw new Error('Portable process did not stop gracefully') }
}

async function connect(origin) {
  const socket = io(origin + '/dashboard', { transports: ['websocket'], auth: { role: 'dashboard', sessionId, clientVersion: '1' }, reconnection: false })
  await Promise.race([new Promise((resolveReady, reject) => { socket.once('session:ready', resolveReady); socket.once('connect_error', reject) }), delay(10_000).then(() => { throw new Error('Portable Dashboard socket did not become ready') })])
  return socket
}
function emitAck(socket, event, payload) { return socket.timeout(5_000).emitWithAck(event, payload) }
function listSessions(socket) { return new Promise((resolveList, reject) => { const timer = setTimeout(() => reject(new Error('Portable Session list timed out')), 5_000); socket.once('server:sessions', (value) => { clearTimeout(timer); resolveList(value) }); socket.emit('client:list_sessions', {}) }) }
async function assertOkJson(response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json() }
async function waitForHttp(url, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return } catch {}; await delay(100) }; throw new Error('Portable process did not become ready') }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) }
function freePort() { return new Promise((resolvePort, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('failed to allocate a port'))) }) }) }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error('missing ' + name); return process.argv[index + 1] }
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
