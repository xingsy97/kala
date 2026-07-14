import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AgentRewardArtifactSchema,
  createArtifactStore,
  type AgentRewardArtifact,
  type AgentRlTask,
  type ArtifactRef,
} from '@agent-kernel/shared/enhancement'

import { detectWriteScopeViolations, writeSnapshotSidecar, type WriteScopeSnapshot } from './write-scope.js'

export type RunCommandVerifierInput = {
  rootDir: string
  rolloutId: string
  task: AgentRlTask
  cwd: string
  writeScopeSnapshot?: WriteScopeSnapshot | null
}

export type RunCommandVerifierResult = {
  artifact: ArtifactRef
  reward: AgentRewardArtifact
}

export async function runCommandVerifier(input: RunCommandVerifierInput): Promise<RunCommandVerifierResult> {
  if (input.task.verifier.kind === 'swebench') {
    const { runSwebenchVerifier } = await import('./verifier-swebench.js')
    return runSwebenchVerifier({
      rootDir: input.rootDir,
      rolloutId: input.rolloutId,
      task: input.task,
      cwd: input.cwd,
    })
  }
  if (input.task.verifier.kind !== 'command') {
    throw new Error(`unsupported verifier for local runner: ${input.task.verifier.kind}`)
  }
  const command = input.task.verifier.command
  if (!command || command.length === 0) throw new Error(`${input.task.taskId}: command verifier requires command`)
  await mkdir(input.rootDir, { recursive: true })
  const startedAt = new Date()
  const run = await runProcess(command, {
    cwd: input.cwd,
    env: input.task.verifier.env,
    timeoutMs: input.task.verifier.timeoutMs,
  })
  const completedAt = new Date()
  const store = createArtifactStore(input.rootDir)
  const base = `rl-verifier/${sanitize(input.rolloutId)}`
  const stdoutRef = await store.writeText('log', `${base}/stdout.txt`, run.stdout)
  const stderrRef = await store.writeText('log', `${base}/stderr.txt`, run.stderr)
  const passRate = parsePassRate(run.stdout, input.task.verifier.rewardParsePattern)
  const violations = input.writeScopeSnapshot
    ? await detectWriteScopeViolations(input.cwd, input.writeScopeSnapshot)
    : []
  if (input.writeScopeSnapshot) {
    await writeSnapshotSidecar(input.rootDir, input.rolloutId, input.writeScopeSnapshot)
  }
  let rewardValue = run.timedOut ? 0 : run.exitCode === 0 ? 1 : 0
  let label: AgentRewardArtifact['label'] = run.timedOut
    ? 'timeout'
    : run.exitCode === 0
      ? 'resolved'
      : 'unresolved'
  if (violations.length > 0) {
    rewardValue = 0
    label = 'unresolved'
  }
  const metadata: Record<string, unknown> = {
    cwd: input.cwd,
    timedOut: run.timedOut,
  }
  if (passRate !== null) metadata.passRate = passRate
  if (violations.length > 0) metadata.writeScopeViolations = violations
  const reward: AgentRewardArtifact = {
    schemaVersion: 'agent.reward.v1',
    rolloutId: input.rolloutId,
    taskId: input.task.taskId,
    verifierKind: 'command',
    reward: rewardValue,
    label,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    command,
    exitCode: run.exitCode,
    signal: run.signal,
    stdoutRef,
    stderrRef,
    metadata,
  }
  AgentRewardArtifactSchema.parse(reward)
  const artifact = await store.writeJson('rl_reward', `rl-rewards/${sanitize(input.rolloutId)}.json`, reward)
  return { artifact, reward }
}

type ProcessResult = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runProcess(command: readonly string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command[0]!, command.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 1000).unref()
    }, opts.timeoutMs)
    timer.unref()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: null, signal: null, stdout, stderr: stderr + error.message, timedOut: false })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ exitCode: code, signal, stdout, stderr, timedOut })
    })
  })
}

export function defaultWorkspaceForTask(rootDir: string, rolloutId: string, task: AgentRlTask): string {
  if (task.workspace.kind === 'empty-tempdir') return join(rootDir, 'rl-workspaces', sanitize(rolloutId))
  if (task.workspace.workdir) return task.workspace.workdir
  return join(rootDir, 'rl-workspaces', sanitize(rolloutId))
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._:-]+/g, '_')
  return cleaned.length > 0 ? cleaned : 'unknown'
}

function parsePassRate(stdout: string, pattern: string | undefined): number | null {
  const source = pattern ?? 'REWARD_PASS_RATE=([0-9.]+)'
  const re = new RegExp(source)
  const match = re.exec(stdout)
  if (!match || !match[1]) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  return value
}
