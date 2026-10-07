#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'
import { PROTOCOL_VERSION } from '../../packages/shared/dist/index.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
const hostRelease = resolve(process.env.PRODUCT_E2E_WINDOWS_HOST_RELEASE_DIR ?? join(root, 'release'))
const executorRelease = resolve(process.env.PRODUCT_E2E_WINDOWS_EXECUTOR_RELEASE_DIR ?? join(root, 'release'))
const target = process.env.PRODUCT_E2E_WINDOWS_TARGET ?? 'executor'
const hostBundle = join(hostRelease, 'kala-dashboard-with-runtime.cjs')
const hostRuntime = join(hostRelease, 'kala-copilot-runtime-win32-x64')
const hostRuntimeNode = join(hostRelease, 'kala-copilot-runtime-node-win32-x64.node')
const executor = join(executorRelease, 'kala-executor-win32-x64.exe')
const serviceHost = join(executorRelease, 'kala-executor-service-host-win32-x64.exe')
const executorPrebuild = join(executorRelease, 'prebuilds', 'win32-x64')
const stateRoot = mkdtempSync(join(tmpdir(), 'kala-windows-terminal-'))
const port = Number(process.env.PRODUCT_E2E_WINDOWS_TERMINAL_PORT ?? 3325)
const origin = `http://127.0.0.1:${port}`
const sessionId = 'windows-terminal-e2e'
const marker = `KALA_CONPTY_${Date.now()}`
const logs = []
const serviceMode = process.env.PRODUCT_E2E_WINDOWS_SERVICE === '1'
let host
let executorProcess
let dashboard
let serviceOwned = false

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('verify-windows-terminal.mjs requires a real Windows x64 runner')
  if (!['host', 'executor'].includes(target)) throw new Error(`unsupported Windows acceptance target ${target}`)
  assertFiles([hostBundle, hostRuntime, hostRuntimeNode], 'Windows Host CJS and native Copilot runtime')

  host = start(process.execPath, [hostBundle], {
    KALA_BIND_HOST: '127.0.0.1', KALA_PORT: String(port), KALA_STATE_DIR: join(stateRoot, 'state'),
    KALA_SESSIONS_DIR: join(stateRoot, 'sessions'), KALA_ARTIFACTS_DIR: join(stateRoot, 'artifacts'), ANTHROPIC_API_KEY: 'unused',
    HOME: stateRoot, USERPROFILE: stateRoot,
    ...(target === 'executor' ? { KALA_RELEASE_ASSETS_DIR: hostRelease } : {}),
  })
  await waitForHttp(`${origin}/models`)
  const dashboardResponse = await fetch(`${origin}/`)
  if (!dashboardResponse.ok || !(dashboardResponse.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`portable Host dashboard is not browser-accessible (${dashboardResponse.status})`)
  }
  if (target === 'host') {
    console.log('PASS Windows x64 Portable Host CJS boot and browser-accessible API')
  } else {
    if (serviceMode) {
      const preexisting = await run('sc.exe', ['query', 'KalaExecutor'])
      if (preexisting.code === 0 || !preexisting.stdout.includes('1060')) throw new Error('Windows Executor service is not absent before isolated installation')
      serviceOwned = true
    }
    await verifyExecutorLifecycle()
  }
} catch (error) {
  console.error(error)
  console.error(logs.join(''))
  process.exitCode = 1
} finally {
  dashboard?.close()
  await Promise.all([stop(executorProcess), stop(host)])
  if (serviceOwned) {
    const remaining = await run('sc.exe', ['query', 'KalaExecutor']).catch(() => ({ code: -1, stdout: '' }))
    if (remaining.code === 0) {
      await run('sc.exe', ['stop', 'KalaExecutor']).catch(() => undefined)
      await run('sc.exe', ['delete', 'KalaExecutor']).catch(() => undefined)
      if (!process.exitCode) {
        console.error('Windows service was not removed by the lifecycle acceptance test')
        process.exitCode = 1
      }
    }
  }
  rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function verifyExecutorLifecycle() {
  assertFiles([
    executor,
    serviceHost,
    ...['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty-agent.exe', 'winpty.dll'].map((name) => join(executorPrebuild, name)),
    join(executorRelease, 'worker', 'conoutSocketWorker.js'),
    join(executorRelease, 'shared', 'conout.js'),
  ], 'Windows native Executor and complete node-pty companion')

  const createResponse = await fetch(`${origin}/api/executor-installs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'windows', mode: serviceMode ? 'service' : 'temporary', privilegeMode: 'privileged', workspaceRoot: stateRoot, label: 'windows-terminal-e2e' }),
  })
  if (!createResponse.ok) {
    const detail = await createResponse.text()
    if (createResponse.status === 422 && detail.includes('windows_installation_unsupported')) {
      throw new Error('Windows Host/Executor lifecycle is blocked: the current Host API rejects Windows installation sessions; integrate the Windows assets into the global release inventory before accepting this target')
    }
    throw new Error(`create Windows install failed: ${createResponse.status} ${detail}`)
  }
  const created = await createResponse.json()
  const claimResponse = await fetch(`${origin}/install/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode: created.setupCode }),
  })
  if (!claimResponse.ok) throw new Error(`claim failed: ${claimResponse.status}`)
  const claim = await claimResponse.json()
  executorProcess = start(executor, ['--internal-installer'], {
    ...claim.env, EXECUTOR_INSTALL_ROOT: stateRoot, HOME: stateRoot, USERPROFILE: stateRoot,
    KALA_TERMINAL_DIAGNOSTICS: '1',
  })
  const completedDeadline = Date.now() + 30_000
  let installationCompleted = false
  while (Date.now() < completedDeadline) {
    const response = await fetch(`${origin}/api/executor-installs/${encodeURIComponent(created.id)}`)
    if (!response.ok) throw new Error(`install status failed: ${response.status}`)
    const snapshot = await response.json()
    if (snapshot.status === 'completed') { installationCompleted = true; break }
    await sleep(100)
  }
  if (!installationCompleted) {
    if (serviceMode) {
      const scm = await run('sc.exe', ['query', 'KalaExecutor'])
      const installDir = join(process.env.ProgramFiles, 'Kala', 'Executor')
      const evidence = Object.fromEntries(['wrapper', 'out', 'err'].map((kind) => {
        const path = join(installDir, `kala-executor-service.${kind}.log`)
        if (!existsSync(path)) return [kind, { present: false }]
        const body = readFileSync(path, 'utf8').slice(-16_384)
        return [kind, {
          bytes: statSync(path).size,
          accessDenied: /access denied|UnauthorizedAccessException/iu.test(body),
          missingFile: /cannot find|not found|FileNotFoundException/iu.test(body),
          configError: /Invalid Executor config|Invalid Executor credential/iu.test(body),
          identityRejected: /workspace_identity_mismatch|auth_failed|workspace_id_conflict/iu.test(body),
          exited: /process exited|exited with code/iu.test(body),
        }]
      }))
      throw new Error(`Windows Executor installation did not complete; SCM state=${scm.stdout.match(/STATE\s*:\s*\d+\s+\w+/u)?.[0] ?? 'unavailable'}; service log signals=${JSON.stringify(evidence)}`)
    }
    throw new Error('Windows Executor installation did not complete')
  }
  if (serviceMode) {
    const status = await run('sc.exe', ['query', 'KalaExecutor'])
    if (status.code !== 0 || !/STATE\s*:\s*4\s+RUNNING/u.test(status.stdout)) throw new Error(`Windows Executor service did not reach RUNNING: ${status.stdout || status.stderr}`)
    const config = await run('sc.exe', ['qc', 'KalaExecutor'])
    if (config.code !== 0 || !config.stdout.includes('kala-executor-service.exe')) throw new Error('SCM did not start the verified service host')
  }

  dashboard = io(`${origin}/dashboard`, { transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false })
  await once(dashboard, 'session:ready')
  let workspaceId
  const workspaceDeadline = Date.now() + 15_000
  while (Date.now() < workspaceDeadline && !workspaceId) {
    const listed = await emitAcklessResponse(dashboard, 'client:list_executors', 'server:executors', {})
    workspaceId = listed.executors.find((candidate) => candidate.installId === created.id)?.workspaceId
    if (!workspaceId) await sleep(100)
  }
  if (!workspaceId) throw new Error('installed Windows Executor did not announce its Workspace')
  const sessionCreated = await emitAck(dashboard, 'client:create_session', { operationId: `session-${Date.now()}`, sessionId, workspaceId, cwd: stateRoot })
  if (!sessionCreated?.ok) throw new Error(`session create failed: ${sessionCreated?.error ?? 'missing success acknowledgement'}`)
  const createdTerminal = await emitAck(dashboard, 'terminal:create', { requestId: `create-${Date.now()}`, workspaceId, sessionId, cwd: stateRoot, cols: 100, rows: 30 })
  if (createdTerminal.error || !createdTerminal.terminalId) throw new Error(`terminal create failed: ${createdTerminal.error ?? 'missing terminalId'}`)
  const output = []
  dashboard.on('server:terminal_output', (payload) => { if (payload.terminalId === createdTerminal.terminalId) output.push(payload.data) })
  dashboard.emit('terminal:resize', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, cols: 120, rows: 40 })
  // ConPTY creation can ACK before PowerShell is ready to consume input. A
  // command's echoed source is not proof of execution; require a result that
  // cannot occur in the source text before testing the real user input once.
  const readyToken = `KALA_READY_${Date.now()}_`
  const readyDeadline = Date.now() + 40_000
  let nextReadyProbe = 0
  while (Date.now() < readyDeadline && !output.join('').includes(`${readyToken}True`)) {
    if (Date.now() >= nextReadyProbe) {
      dashboard.emit('terminal:input', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, data: `Write-Output ("${readyToken}" + (2 -eq 2))\r` })
      nextReadyProbe = Date.now() + 3_000
    }
    await sleep(50)
  }
  if (!output.join('').includes(`${readyToken}True`)) throw new Error(`PowerShell was not ready after ConPTY create; output=${output.join('').slice(-2000)}`)
  dashboard.emit('terminal:input', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, data: `Write-Output ${marker}\r` })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !output.join('').includes(marker)) await sleep(50)
  if (!output.join('').includes(marker)) throw new Error(`terminal did not echo marker; output=${output.join('').slice(-2000)}`)

  const ptyProbe = `KALA_PTY_${Date.now()}_`
  dashboard.emit('terminal:input', { workspaceId, sessionId, terminalId: createdTerminal.terminalId, data: `Write-Output ("${ptyProbe}" + [Console]::IsOutputRedirected)\r` })
  const ptyDeadline = Date.now() + 15_000
  while (Date.now() < ptyDeadline && !output.join('').includes(`${ptyProbe}False`) && !output.join('').includes(`${ptyProbe}True`)) await sleep(50)
  if (!output.join('').includes(`${ptyProbe}False`)) throw new Error('Windows Terminal used redirected pipes instead of ConPTY')
  const killed = await emitAck(dashboard, 'terminal:kill', { requestId: `kill-${Date.now()}`, workspaceId, sessionId, terminalId: createdTerminal.terminalId })
  if (!killed.killed) throw new Error(`terminal kill failed: ${killed.error ?? 'unknown'}`)
  if (logs.join('').includes('Failed to load native module: conpty.node')) throw new Error(`ConPTY native load failed:\n${logs.join('')}`)

  if (serviceMode) {
    const installDir = join(process.env.ProgramFiles, 'Kala', 'Executor')
    const dataDir = join(process.env.ProgramData, 'Kala', 'Executor')
    const installedExecutor = join(installDir, 'kala-executor.exe')
    assertFiles([installedExecutor, join(installDir, 'kala-executor-service.exe'), join(installDir, 'prebuilds', 'win32-x64', 'conpty.node'),
      join(installDir, 'worker', 'conoutSocketWorker.js'), join(installDir, 'shared', 'conout.js'),
      join(dataDir, 'config.json')], 'managed Windows service installation')
    const uninstall = await run(installedExecutor, ['service', 'uninstall'])
    if (uninstall.code !== 0 || !uninstall.stdout.includes('Kala Executor Windows service and credentials were removed')) throw new Error(`Windows service uninstall failed: ${uninstall.stderr}`)
    const uninstallDeadline = Date.now() + 30_000
    while (Date.now() < uninstallDeadline && (existsSync(installDir) || existsSync(dataDir))) await sleep(100)
    const removalStatus = join(tmpdir(), `kala-executor-uninstall-${uninstall.pid}.status`)
    if (existsSync(installDir) || existsSync(dataDir)) {
      const outcome = existsSync(removalStatus) ? readFileSync(removalStatus, 'utf8') : 'helper-not-started-or-still-waiting'
      const helperScript = join(tmpdir(), `kala-executor-uninstall-${uninstall.pid}.ps1`)
      let syntaxErrors = 'helper-missing'
      if (existsSync(helperScript)) {
        const safePath = helperScript.replaceAll("'", "''")
        const parsed = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$tokens=$null;$parseErrors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${safePath}',[ref]$tokens,[ref]$parseErrors)|Out-Null;foreach($entry in $parseErrors){Write-Output ($entry.ErrorId + ':line-' + $entry.Extent.StartLineNumber)}`])
        syntaxErrors = parsed.code === 0 ? (parsed.stdout.trim() || 'none') : 'parser-failed'
      }
      const errorPath = join(tmpdir(), `kala-executor-uninstall-${uninstall.pid}.err`)
      const outputPath = join(tmpdir(), `kala-executor-uninstall-${uninstall.pid}.out`)
      const helperError = existsSync(errorPath) ? readFileSync(errorPath, 'utf8') : ''
      const helperOutput = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
      const errorKinds = ['ParameterBindingException', 'UnauthorizedAccessException', 'ParserError', 'CommandNotFoundException', 'IOException', 'MethodException', 'ArgumentException'].filter((kind) => helperError.includes(kind))
      const processes = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter \"name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*kala-executor-uninstall-${uninstall.pid}.ps1*' }).Count`])
      throw new Error(`Windows service uninstall left managed installation data; self-removal=${outcome}; syntaxErrors=${syntaxErrors}; helperErrorBytes=${Buffer.byteLength(helperError)}; helperOutputBytes=${Buffer.byteLength(helperOutput)}; helperErrorKinds=${errorKinds.join(',') || 'none'}; helperProcessCount=${processes.code === 0 ? processes.stdout.trim() : 'unknown'}; installDir=${existsSync(installDir)}; dataDir=${existsSync(dataDir)}`)
    }
    rmSync(removalStatus, { force: true })
    rmSync(join(tmpdir(), `kala-executor-uninstall-${uninstall.pid}.out`), { force: true })
    rmSync(join(tmpdir(), `kala-executor-uninstall-${uninstall.pid}.err`), { force: true })
  }
  console.log(`PASS Windows native Executor ${serviceMode ? 'service' : 'temporary'} ConPTY create/input/resize/kill lifecycle`)
}

function assertFiles(paths, label) {
  const missing = paths.filter((path) => !existsSync(path))
  if (missing.length > 0) throw new Error(`${label} is incomplete; missing: ${missing.join(', ')}`)
}
function start(file, args, env) {
  const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  child.once('error', (error) => logs.push(`${error.stack ?? error}\n`))
  return child
}
function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    child.kill()
  })
}
function run(file, args) { return new Promise((resolvePromise, reject) => { const child = spawn(file, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk }); child.once('error', reject); child.once('exit', (code) => resolvePromise({ code, stdout, stderr, pid: child.pid })) }) }
async function waitForHttp(url) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return } catch {} if (host?.exitCode !== null) throw new Error(`Host exited before becoming available (${host.exitCode})`); await sleep(100) } throw new Error(`Host unavailable: ${url}`) }
function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }
function once(socket, event) { return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 15_000); socket.once(event, (payload) => { clearTimeout(timer); resolvePromise(payload) }) }) }
function emitAck(socket, event, payload) { return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 15_000); socket.emit(event, payload, (result) => { clearTimeout(timer); resolvePromise(result) }) }) }
function emitAcklessResponse(socket, requestEvent, responseEvent, payload) { return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => reject(new Error(`${responseEvent} timed out`)), 15_000); socket.once(responseEvent, (result) => { clearTimeout(timer); resolvePromise(result) }); socket.emit(requestEvent, payload) }) }
