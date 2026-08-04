#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import process from 'node:process'

import { codexProviderConfigArgs } from '../src/provider-config.js'

type DriverArgs = { model: string; cwd: string; finalResponse: string; effort?: string; baseUrl?: string }
type RpcId = string | number
type RpcMessage = { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: unknown }
type Pending = { resolve(value: unknown): void; reject(error: unknown): void }

if (process.argv.includes('--version')) { process.stdout.write('Codex app-server evaluation driver 0.0.0\n'); process.exit(0) }

let child: ChildProcessWithoutNullStreams | undefined
let threadId: string | undefined
let turnId: string | undefined
let stopping = false
const pending = new Map<RpcId, Pending>()
let nextId = 1
let finalResponse = ''
let completedResolve!: (value: Record<string, unknown>) => void
let completedReject!: (error: unknown) => void
const completed = new Promise<Record<string, unknown>>((resolve, reject) => { completedResolve = resolve; completedReject = reject })

void main().catch(async (error: unknown) => {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
  await shutdown(); process.exitCode = 1
})
process.on('SIGTERM', () => { void shutdown().then(() => { process.exitCode = 143 }) })
process.on('SIGINT', () => { void shutdown().then(() => { process.exitCode = 130 }) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2)); const prompt = await readStdin()
  const serverArgs = ['app-server', '--listen', 'stdio://']
  if (args.baseUrl) serverArgs.push(...codexProviderConfigArgs(args.baseUrl))
  child = spawn('codex', serverArgs, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  child.once('error', (error) => rejectAll(error))
  child.once('exit', (code, signal) => { if (!stopping) rejectAll(new Error('codex app-server exited before turn completion: ' + String(code ?? signal))) })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }); lines.on('line', receive)
  await rpc('initialize', { clientInfo: { name: 'agent_evaluation_platform', title: 'Agent Evaluation Platform', version: '0.0.0' } })
  notify('initialized', {})
  const started = record(await rpc('thread/start', { model: args.model, cwd: args.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', serviceName: 'agent_evaluation_platform' }))
  threadId = string(record(started.thread).id); if (!threadId) throw new Error('thread/start response omitted thread.id')
  const turnParams: Record<string, unknown> = { threadId, input: [{ type: 'text', text: prompt }], cwd: args.cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, model: args.model }
  if (args.effort) turnParams.effort = args.effort
  const turnStarted = record(await rpc('turn/start', turnParams)); turnId = string(record(turnStarted.turn).id)
  const terminal = await completed
  if (finalResponse) await writeFile(args.finalResponse, finalResponse, { encoding: 'utf8', mode: 0o600 })
  const status = string(record(terminal.turn).status)
  if (status !== 'completed') throw new Error('Codex turn ended with status ' + (status ?? 'unknown') + ': ' + diagnostic(record(terminal.turn).error))
  await shutdown()
}

function receive(line: string): void {
  if (!line.trim()) return
  let message: RpcMessage
  try { message = JSON.parse(line) as RpcMessage } catch { process.stderr.write('codex app-server emitted invalid JSONL\n'); return }
  process.stdout.write(JSON.stringify(message) + '\n')
  if (message.id !== undefined && !message.method) {
    const request = pending.get(message.id); if (!request) return; pending.delete(message.id)
    message.error === undefined ? request.resolve(message.result) : request.reject(new Error('Codex app-server RPC failed: ' + diagnostic(message.error)))
    return
  }
  if (message.id !== undefined && message.method) { respondToServerRequest(message); return }
  const params = record(message.params)
  if (message.method === 'item/completed') {
    const item = record(params.item)
    if (item.type === 'agentMessage' && typeof item.text === 'string') finalResponse = item.text
  }
  if (message.method === 'turn/started') turnId = string(record(params.turn).id) ?? turnId
  if (message.method === 'turn/completed') completedResolve(params)
  if (message.method === 'error' && params.willRetry !== true) completedReject(new Error('Codex turn error: ' + diagnostic(params.error)))
}
function respondToServerRequest(message: RpcMessage): void {
  if (!child || message.id === undefined) return
  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') { send({ id: message.id, result: { decision: 'accept' } }); return }
  send({ id: message.id, error: { code: -32601, message: 'Evaluation client cannot satisfy interactive request: ' + String(message.method) } })
}
async function rpc(method: string, params: unknown): Promise<unknown> {
  const id = nextId++; const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject })); send({ id, method, params }); return await response
}
function notify(method: string, params: unknown): void { send({ method, params }) }
function send(message: RpcMessage): void { if (!child || child.stdin.destroyed) throw new Error('Codex app-server stdin is unavailable'); child.stdin.write(JSON.stringify(message) + '\n') }
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true
  if (child && threadId && turnId && child.exitCode === null) { try { send({ id: nextId++, method: 'turn/interrupt', params: { threadId, turnId } }) } catch {} }
  child?.kill('SIGTERM'); await new Promise<void>((resolve) => { if (!child || child.exitCode !== null || child.signalCode !== null) resolve(); else { const timer = setTimeout(() => { child?.kill('SIGKILL'); resolve() }, 1_000); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve() }) } })
}
function rejectAll(error: unknown): void { for (const request of pending.values()) request.reject(error); pending.clear(); completedReject(error) }
function parseArgs(argv: readonly string[]): DriverArgs {
  const values = new Map<string, string>(); for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith('--') || value === undefined) throw new Error('invalid Codex app-server driver arguments'); values.set(key, value) }
  const effort = values.get('--effort'); const baseUrl = values.get('--base-url')
  return { model: required(values, '--model'), cwd: required(values, '--cwd'), finalResponse: required(values, '--final-response'), ...(effort ? { effort } : {}), ...(baseUrl ? { baseUrl } : {}) }
}
function required(values: Map<string, string>, key: string): string { const value = values.get(key); if (!value) throw new Error('missing ' + key); return value }
async function readStdin(): Promise<string> { let body = ''; for await (const chunk of process.stdin) body += String(chunk); if (!body.trim()) throw new Error('task prompt is empty'); return body }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function string(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function diagnostic(value: unknown): string { try { return JSON.stringify(value).slice(0, 1_000) } catch { return String(value) } }
