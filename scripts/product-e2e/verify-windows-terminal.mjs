#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'

const root = fileURLToPath(new URL('../..', import.meta.url))
const release = join(root, 'release')
const hostBundle = join(release, 'bundle-dashboard-with-runtime.cjs')
const windowsTarget = process.arch === 'arm64' ? 'win32-arm64' : process.arch === 'x64' ? 'win32-x64' : ''
if (!windowsTarget) throw new Error(`unsupported Windows architecture ${process.arch}`)
const executor = join(release, `runlab-executor-${windowsTarget}.exe`)
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-windows-terminal-'))
const port = Number(process.env.PRODUCT_E2E_WINDOWS_TERMINAL_PORT ?? 3325)
const origin = `http://127.0.0.1:${port}`
const sessionId = 'windows-terminal-e2e'
const marker = `RUNLAB_CONPTY_${Date.now()}`
const logs = []
const serviceMode = process.env.PRODUCT_E2E_WINDOWS_SERVICE === '1'
let host
let executorProcess
let dashboard

try {
  if (process.platform !== 'win32') throw new Error('verify-windows-terminal.mjs must run on a real Windows runner')
  host = start('node', [hostBundle], {
    HOST_LISTEN_HOST: '127.0.0.1', HOST_PORT: String(port), AGENT_KERNEL_STATE_DIR: join(stateRoot, 'state'),
    SESSIONS_DIR: join(stateRoot, 'sessions'), AGENT_KERNEL_ARTIFACTS_DIR: join(stateRoot, 'artifacts'), ANTHROPIC_API_KEY: 'unused',
  })
  await waitForHttp(`${origin}/models`)
  const created = await fetch(`${origin}/api/executor-installs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'windows', mode: serviceMode ? 'service' : 'temporary', workspaceRoot: stateRoot, label: 'windows-terminal-e2e' }),
  }).then(async (response) => response.ok ? response.json() : Promise.reject(new Error(`create install failed: ${response.status}`)))
  const claim = await fetch(`${origin}/install/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode: created.setupCode }),
  }).then(async (response) => response.ok ? response.json() : Promise.reject(new Error(`claim failed: ${response.status}`)))
  executorProcess = start(executor, ['--internal-installer'], { ...claim.env, EXECUTOR_INSTALL_ROOT: stateRoot })
  const completedDeadline = Date.now() + 30_000
  let installationCompleted = false
  while (Date.now() < completedDeadline) {
    const snapshot = await fetch(`${origin}/api/executor-installs/${encodeURIComponent(created.id)}`).then((response) => response.json())
    if (snapshot.status === 'completed') { installationCompleted = true; break }
    await sleep(100)
  }
  if (!installationCompleted) throw new Error('Windows Executor installation did not complete')
  dashboard = io(`${origin}/dashboard`, { transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: '1' }, reconnection: false })
  await once(dashboard, 'session:ready')
  let workspaceId
  const workspaceDeadline = Date.now() + 15_000
  while (Date.now() < workspaceDeadline && !workspaceId) {
    const listed = await emitAcklessResponse(dashboard, 'client:list_executors', 'server:executors', {})
    workspaceId = listed.executors.find((candidate) => candidate.installId === created.id)?.workspaceId ?? listed.executors[0]?.workspaceId
    if (!workspaceId) await sleep(100)
  }
  if (!workspaceId) throw new Error('installed Windows Executor did not announce a Workspace')
  const requestId = `create-${Date.now()}`
  const createdTerminal = await emitAck(dashboard, 'terminal:create', { requestId, workspaceId, sessionId, cwd: stateRoot, cols: 100, rows: 30 })
  if (createdTerminal.error || !createdTerminal.terminalId) throw new Error(`terminal create failed: ${createdTerminal.error ?? 'missing terminalId'}`)
  const output = []
  dashboard.on('server:terminal_output', (payload) => { if (payload.terminalId === createdTerminal.terminalId) output.push(payload.data) })
  dashboard.emit('terminal:resize', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, cols: 120, rows: 40 })
  dashboard.emit('terminal:input', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, data: `Write-Output ${marker}\r` })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !output.join('').includes(marker)) await sleep(50)
  if (!output.join('').includes(marker)) throw new Error(`terminal did not echo marker; output=${output.join('').slice(-2000)}`)
  const killed = await emitAck(dashboard, 'terminal:kill', { requestId: `kill-${Date.now()}`, workspaceId, sessionId, terminalId: createdTerminal.terminalId })
  if (!killed.killed) throw new Error(`terminal kill failed: ${killed.error ?? 'unknown'}`)
  if (logs.join('').includes('Failed to load native module: conpty.node')) throw new Error(`ConPTY native load failed:\n${logs.join('')}`)
  if (serviceMode) {
    const installDir = join(process.env.ProgramFiles, 'Agent RunLab', 'Executor')
    const dataDir = join(process.env.ProgramData, 'Agent RunLab', 'Executor')
    const installedExecutor = join(installDir, 'runlab-executor.exe')
    if (!existsSync(installedExecutor) || !existsSync(join(installDir, 'prebuilds', windowsTarget, 'conpty.node'))) throw new Error('Windows service installation omitted the executable or ConPTY companion')
    const uninstall = await run(installedExecutor, ['service', 'uninstall'])
    if (uninstall.code !== 0 || !uninstall.stdout.includes('Windows service and credentials were removed')) throw new Error(`Windows service uninstall failed: ${uninstall.stderr}`)
    const uninstallDeadline = Date.now() + 30_000
    while (Date.now() < uninstallDeadline && (existsSync(installDir) || existsSync(dataDir))) await sleep(100)
    if (existsSync(installDir) || existsSync(dataDir)) throw new Error('Windows service uninstall left managed installation data')
  }
  console.log('PASS Windows Executor ConPTY Terminal create/input/resize/kill E2E')
} catch (error) {
  console.error(error)
  console.error(logs.join(''))
  process.exitCode = 1
} finally {
  dashboard?.close()
  executorProcess?.kill()
  host?.kill()
  rmSync(stateRoot, { recursive: true, force: true })
}

function start(file, args, env) {
  const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  return child
}
function run(file, args) { return new Promise((resolve, reject) => { const child = spawn(file, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk }); child.once('error', reject); child.once('exit', (code) => resolve({ code, stdout, stderr })) }) }
async function waitForHttp(url) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return } catch {} await sleep(100) } throw new Error(`Host unavailable: ${url}`) }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function once(socket, event) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 15_000); socket.once(event, (payload) => { clearTimeout(timer); resolve(payload) }) }) }
function emitAck(socket, event, payload) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 15_000); socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result) }) }) }
function emitAcklessResponse(socket, requestEvent, responseEvent, payload) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${responseEvent} timed out`)), 15_000); socket.once(responseEvent, (result) => { clearTimeout(timer); resolve(result) }); socket.emit(requestEvent, payload) }) }
