#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'

import { PROTOCOL_VERSION, type DashboardClientToServerEvents, type DashboardServerToClientEvents, type RpcAck, type StateChangedEvent } from '@agent-kernel/shared'
import { io, type Socket } from 'socket.io-client'

const DRIVER_VERSION = '0.0.0'
type DriverArgs = { sessionId: string; workspace: string; model: string; provider: 'openai' | 'anthropic'; timeoutMs: number }
type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
const children = new Set<ChildProcess>()
let dashboard: DashboardSocket | undefined
let shuttingDown = false

if (process.argv.includes('--version')) { process.stdout.write('Kala evaluation driver ' + DRIVER_VERSION + '\n'); process.exit(0) }

void main().catch(async (error: unknown) => {
  emit({ type: 'runlab.error', message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) })
  await shutdown(); process.exitCode = 1
})
process.on('SIGTERM', () => { void shutdown().then(() => { process.exitCode = 143 }) })
process.on('SIGINT', () => { void shutdown().then(() => { process.exitCode = 130 }) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2)); const prompt = await readStdin(); const port = await freePort()
  const root = '/tmp/agent-runlab'; const hostHome = join(root, 'host-home'); const executorHome = join(root, 'executor-home'); const sessions = join(root, 'sessions'); const hostArtifacts = join(root, 'host-artifacts'); const workspaceIdPath = join(root, 'workspace-id')
  const workspaceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; const executorToken = 'trial-local-' + process.pid.toString(36)
  await mkdir(root, { recursive: true })
  await Promise.all([mkdir(hostHome, { recursive: true }), mkdir(executorHome, { recursive: true }), mkdir(sessions, { recursive: true }), mkdir(hostArtifacts, { recursive: true }), mkdir('/artifacts', { recursive: true }), writeFile(workspaceIdPath, workspaceId + '\n', { mode: 0o600 })])
  await writeHostProviderConfig(hostHome, args)
  const hostEnvironment: NodeJS.ProcessEnv = {
    ...process.env, HOME: hostHome, HOST_PORT: String(port), SESSIONS_DIR: sessions, AGENT_KERNEL_ARTIFACTS_DIR: hostArtifacts, HOST_AUDIT_DIR: join(root, 'audit'), HOST_EXECUTOR_IDENTITIES: join(root, 'executor-identities.json'),
    EXECUTOR_TOKENS: JSON.stringify([{ token: executorToken, workspaceId, label: 'evaluation' }]), AGENT_KERNEL_PROVIDER: args.provider, HOST_MODEL: args.model, AK_ALLOW_ALL_OK: '1', LOG_FORMAT: 'json', LOG_LEVEL: 'info',
  }
  const host = child('host', 'agent-kernel-host', ['--port', String(port)], hostEnvironment)
  host.once('exit', (code, signal) => { if (!shuttingDown) emit({ type: 'runlab.process.exit', process: 'host', code, signal }) })
  dashboard = await connectDashboard('http://127.0.0.1:' + String(port), args.sessionId, args.timeoutMs)
  wireDashboardEvents(dashboard)
  const executorEnvironment: NodeJS.ProcessEnv = {
    ...process.env, HOME: executorHome, HOST_URL: 'http://127.0.0.1:' + String(port), EXECUTOR_TOKEN: executorToken, AGENT_KERNEL_WORKSPACE_ID_FILE: workspaceIdPath, AGENT_KERNEL_NO_UPDATE_CHECK: '1', SANDBOX_ROOTS: args.workspace, WORKSPACE_NAME: 'evaluation', LOG_FORMAT: 'json', LOG_LEVEL: 'info',
  }
  let announced = false
  let resolveAnnounced!: () => void
  let rejectAnnounced!: (error: Error) => void
  const executorAnnounced = new Promise<void>((resolve, reject) => { resolveAnnounced = resolve; rejectAnnounced = reject })
  const executor = child('executor', 'agent-kernel-executor', ['--host', 'http://127.0.0.1:' + String(port), '--sandbox-root', args.workspace, '--name', 'evaluation', '--token', executorToken, '--no-update-check'], executorEnvironment, (text) => {
    if (!announced && text.includes('executor announced; awaiting tool calls')) { announced = true; emit({ type: 'runlab.executor.ready', workspaceId }); resolveAnnounced() }
  })
  executor.once('exit', (code, signal) => { if (!announced) rejectAnnounced(new Error('Executor exited before announcing: ' + String(code ?? signal))); if (!shuttingDown) emit({ type: 'runlab.process.exit', process: 'executor', code, signal }) })
  await withTimeout(executorAnnounced, Math.min(args.timeoutMs, 60_000), 'Executor announce timeout')
  await rpc(dashboard, 'client:create_session', { sessionId: args.sessionId, workspaceId, workspaceName: 'evaluation', cwd: args.workspace, selectedModel: args.model }, args.timeoutMs)
  await setAllowAll(dashboard, args.sessionId, args.timeoutMs)
  const finalState = await runPrompt(dashboard, args.sessionId, prompt, args.timeoutMs)
  await collectNativeEvidence(sessions, args.sessionId, root)
  emit({ type: 'runlab.completed', sessionId: args.sessionId, usage: finalState.state.usage, model: args.model })
  await shutdown()
}

function child(label: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv, observeStderr?: (text: string) => void): ChildProcess {
  const processHandle = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(processHandle)
  processHandle.stdout?.on('data', (chunk: Buffer) => process.stderr.write('[' + label + ':stdout] ' + chunk.toString('utf8')))
  processHandle.stderr?.on('data', (chunk: Buffer) => { const text = chunk.toString('utf8'); process.stderr.write('[' + label + ':stderr] ' + text); observeStderr?.(text) })
  processHandle.once('exit', () => children.delete(processHandle)); return processHandle
}
async function connectDashboard(url: string, sessionId: string, timeoutMs: number): Promise<DashboardSocket> {
  const deadline = Date.now() + Math.min(timeoutMs, 60_000); let lastError = 'Host not ready'
  while (Date.now() < deadline) {
    const socket: DashboardSocket = io(url + '/dashboard', { transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false, timeout: 2_000 })
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('dashboard connect timeout')), 2_500); socket.once('connect', () => { clearTimeout(timer); resolve() }); socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) }) })
      emit({ type: 'runlab.driver.ready', sessionId, url }); return socket
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); socket.close(); await delay(100) }
  }
  throw new Error('Kala Host did not accept Dashboard connection: ' + lastError)
}
function wireDashboardEvents(socket: DashboardSocket): void {
  socket.on('session:ready', (payload) => emit({ type: 'runlab.session.ready', payload }))
  socket.on('event:appended', (payload) => emit({ type: 'runlab.event.appended', payload }))
  socket.on('state:changed', (payload) => emit({ type: 'runlab.state.changed', payload }))
  socket.on('session:error', (payload) => emit({ type: 'runlab.session.error', payload }))
  socket.on('approval:required', (payload) => emit({ type: 'runlab.approval.required', payload }))
  socket.on('server:executors', (payload) => emit({ type: 'runlab.executors', payload }))
}
async function setAllowAll(socket: DashboardSocket, sessionId: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('approval mode change timeout')) }, Math.min(timeoutMs, 10_000))
    const changed: DashboardServerToClientEvents['state:changed'] = (payload) => { if (payload.sessionId === sessionId && payload.state.approvalMode === 'allow_all') { cleanup(); resolve() } }
    const failed: DashboardServerToClientEvents['session:error'] = (payload) => { if (payload.sessionId === sessionId) { cleanup(); reject(new Error(payload.message)) } }
    const cleanup = () => { clearTimeout(timer); socket.off('state:changed', changed); socket.off('session:error', failed) }; socket.on('state:changed', changed); socket.on('session:error', failed); socket.emit('client:set_approval_mode', { sessionId, mode: 'allow_all' })
  })
}
async function runPrompt(socket: DashboardSocket, sessionId: string, prompt: string, timeoutMs: number): Promise<StateChangedEvent> {
  return await new Promise<StateChangedEvent>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Kala absolute deadline reached')) }, timeoutMs)
    const changed: DashboardServerToClientEvents['state:changed'] = (payload) => { if (payload.sessionId !== sessionId) return; if (payload.state.status === 'done') { cleanup(); resolve(payload) }; if (payload.state.status === 'error') { cleanup(); reject(new Error(payload.state.error)) } }
    const failed: DashboardServerToClientEvents['session:error'] = (payload) => { if (payload.sessionId === sessionId) { cleanup(); reject(new Error(payload.message)) } }
    const cleanup = () => { clearTimeout(timer); socket.off('state:changed', changed); socket.off('session:error', failed) }; socket.on('state:changed', changed); socket.on('session:error', failed)
    void rpc(socket, 'client:user_message', { sessionId, text: prompt }, Math.min(timeoutMs, 15_000)).catch((error) => { cleanup(); reject(error) })
  })
}
async function collectNativeEvidence(sessions: string, sessionId: string, root: string): Promise<void> {
  const file = (await readdir(sessions)).find((name) => name.endsWith('_' + sessionId + '.jsonl'))
  if (!file) throw new Error('fresh Kala session ledger was not created')
  await cp(join(sessions, file), '/artifacts/runlab-session.jsonl')
  await command('tar', ['-cf', '/artifacts/runlab-native.tar', '-C', root, 'sessions', 'host-artifacts'])
}
async function writeHostProviderConfig(home: string, args: DriverArgs): Promise<void> {
  if (args.provider === 'openai') {
    requiredEnvironment('OPENAI_API_KEY')
    const configDir = join(home, '.codex'); await mkdir(configDir, { recursive: true })
    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
    const toml = ['model = ' + JSON.stringify(args.model), 'model_provider = "evaluation"', '[model_providers.evaluation]', 'name = "evaluation"', 'base_url = ' + JSON.stringify(baseUrl), 'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"', ''].join('\n')
    await writeFile(join(configDir, 'config.toml'), toml, { mode: 0o600 }); return
  }
  const configDir = join(home, '.claude'); await mkdir(configDir, { recursive: true })
  requiredEnvironment('ANTHROPIC_API_KEY')
  const environment: Record<string, string> = { ANTHROPIC_MODEL: args.model }
  if (process.env.ANTHROPIC_BASE_URL) environment.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: environment }), { mode: 0o600 })
}
async function command(binary: string, args: readonly string[]): Promise<void> {
  const handle = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; handle.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const code = await new Promise<number | null>((resolve, reject) => { handle.once('error', reject); handle.once('exit', resolve) }); if (code !== 0) throw new Error(binary + ' failed: ' + stderr.slice(0, 500))
}
async function rpc(socket: DashboardSocket, event: 'client:create_session' | 'client:user_message', payload: Parameters<DashboardClientToServerEvents['client:create_session']>[0] | Parameters<DashboardClientToServerEvents['client:user_message']>[0], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(event + ' acknowledgement timeout')), timeoutMs)
    const ack = (result: RpcAck) => { clearTimeout(timer); result.ok ? resolve() : reject(new Error(result.error)) }
    if (event === 'client:create_session') socket.emit('client:create_session', payload as Parameters<DashboardClientToServerEvents['client:create_session']>[0], ack)
    else socket.emit('client:user_message', payload as Parameters<DashboardClientToServerEvents['client:user_message']>[0], ack)
  })
}
async function shutdown(): Promise<void> {
  if (shuttingDown) return; shuttingDown = true; dashboard?.close()
  const active = [...children]; for (const handle of active) handle.kill('SIGTERM')
  await Promise.race([Promise.all(active.map((handle) => new Promise<void>((resolve) => { if (handle.exitCode !== null || handle.signalCode !== null) resolve(); else handle.once('exit', () => resolve()) }))), delay(2_000)])
  for (const handle of children) handle.kill('SIGKILL')
}
function parseArgs(argv: readonly string[]): DriverArgs {
  const values = new Map<string, string>(); for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith('--') || value === undefined) throw new Error('invalid Kala driver arguments'); values.set(key, value) }
  const provider = values.get('--provider'); const timeoutMs = Number(values.get('--timeout-ms')); if (provider !== 'openai' && provider !== 'anthropic') throw new Error('invalid provider'); if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid timeout')
  const sessionId = required(values, '--session-id'); if (basename(sessionId) !== sessionId) throw new Error('invalid session id')
  return { sessionId, workspace: required(values, '--workspace'), model: required(values, '--model'), provider, timeoutMs }
}
function required(values: Map<string, string>, key: string): string { const value = values.get(key); if (!value) throw new Error('missing ' + key); return value }
function requiredEnvironment(key: string): string { const value = process.env[key]; if (!value) throw new Error('missing resolved credential environment for ' + key); return value }
async function readStdin(): Promise<string> { let body = ''; for await (const chunk of process.stdin) body += String(chunk); if (!body.trim()) throw new Error('task prompt is empty'); return body }
async function freePort(): Promise<number> { const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('unable to allocate Host port'); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return address.port }
function emit(value: unknown): void { process.stdout.write(JSON.stringify(value) + '\n') }
async function delay(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)) }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })]) }
  finally { if (timer) clearTimeout(timer) }
}
