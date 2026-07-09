import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'

export type ProgramBenchCompileProbe = {
  schema_version: 1
  kind: 'programbench_compile_probe'
  ok: boolean
  status: 'passed' | 'failed' | 'skipped' | 'timeout' | 'error'
  workspace_root: string
  docker_image: string | null
  timeout_ms: number
  command: readonly string[]
  exit_code: number | null
  signal: string | null
  duration_ms: number
  stdout: string
  stderr: string
  reason_codes: readonly string[]
}

export type RunProgramBenchCompileProbeOptions = {
  workspaceRoot: string
  dockerImage?: string | null
  timeoutMs: number
  maxOutputChars?: number
}

export async function runProgramBenchCompileProbe(
  options: RunProgramBenchCompileProbeOptions,
): Promise<ProgramBenchCompileProbe> {
  const maxOutputChars = options.maxOutputChars ?? 20_000
  const compilePath = join(options.workspaceRoot, 'compile.sh')
  const exists = await access(compilePath, constants.F_OK).then(() => true, () => false)
  if (!exists) {
    return skippedProbe(options, 'compile_sh_missing')
  }
  const executable = await access(compilePath, constants.X_OK).then(() => true, () => false)
  if (!executable) {
    return skippedProbe(options, 'compile_sh_not_executable')
  }

  const command = options.dockerImage
    ? [
        'docker', 'run', '--rm', '--network', 'none',
        '-v', `${options.workspaceRoot}:/workspace`,
        '-w', '/workspace',
        options.dockerImage,
        'bash', '-lc', './compile.sh',
      ]
    : ['bash', '-lc', './compile.sh']
  const started = Date.now()

  try {
    const result = await captureProcess(command, {
      cwd: options.workspaceRoot,
      timeoutMs: options.timeoutMs,
      maxOutputChars,
    })
    const reasonCodes = result.exitCode === 0 ? [] : ['compile_failed']
    return {
      schema_version: 1,
      kind: 'programbench_compile_probe',
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      workspace_root: options.workspaceRoot,
      docker_image: options.dockerImage ?? null,
      timeout_ms: options.timeoutMs,
      command,
      exit_code: result.exitCode,
      signal: result.signal,
      duration_ms: Date.now() - started,
      stdout: result.stdout,
      stderr: result.stderr,
      reason_codes: reasonCodes,
    }
  } catch (error) {
    if (error instanceof ProbeTimeoutError) {
      return {
        schema_version: 1,
        kind: 'programbench_compile_probe',
        ok: false,
        status: 'timeout',
        workspace_root: options.workspaceRoot,
        docker_image: options.dockerImage ?? null,
        timeout_ms: options.timeoutMs,
        command,
        exit_code: null,
        signal: 'SIGKILL',
        duration_ms: Date.now() - started,
        stdout: trimOutput(error.stdout, maxOutputChars),
        stderr: trimOutput(error.stderr, maxOutputChars),
        reason_codes: ['compile_timeout'],
      }
    }
    return {
      schema_version: 1,
      kind: 'programbench_compile_probe',
      ok: false,
      status: 'error',
      workspace_root: options.workspaceRoot,
      docker_image: options.dockerImage ?? null,
      timeout_ms: options.timeoutMs,
      command,
      exit_code: null,
      signal: null,
      duration_ms: Date.now() - started,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      reason_codes: ['compile_probe_error'],
    }
  }
}

function skippedProbe(options: RunProgramBenchCompileProbeOptions, reason: string): ProgramBenchCompileProbe {
  return {
    schema_version: 1,
    kind: 'programbench_compile_probe',
    ok: false,
    status: 'skipped',
    workspace_root: options.workspaceRoot,
    docker_image: options.dockerImage ?? null,
    timeout_ms: options.timeoutMs,
    command: [],
    exit_code: null,
    signal: null,
    duration_ms: 0,
    stdout: '',
    stderr: '',
    reason_codes: [reason],
  }
}

async function captureProcess(
  command: readonly string[],
  options: { cwd: string; timeoutMs: number; maxOutputChars: number },
): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      terminateProcess(child.pid, 'SIGTERM')
      setTimeout(() => terminateProcess(child.pid, 'SIGKILL'), 2_000).unref?.()
      reject(new ProbeTimeoutError(stdout, stderr))
    }, options.timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk) => { stdout = trimOutput(stdout + String(chunk), options.maxOutputChars) })
    child.stderr.on('data', (chunk) => { stderr = trimOutput(stderr + String(chunk), options.maxOutputChars) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, signal, stdout, stderr })
    })
  })
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') process.kill(pid, signal)
    else process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already exited.
    }
  }
}

function trimOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.floor(maxChars / 2))}\n[...truncated...]\n${value.slice(-Math.floor(maxChars / 2))}`
}

class ProbeTimeoutError extends Error {
  constructor(readonly stdout: string, readonly stderr: string) {
    super('compile probe timed out')
    this.name = 'ProbeTimeoutError'
  }
}
