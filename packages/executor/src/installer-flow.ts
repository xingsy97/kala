import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ExecutorInstallMode, ExecutorInstallStatusSnapshot } from '@agent-kernel/shared'

import type { InstallerSession } from './installer-session.js'

export type BootstrapEnvironment = {
  HOST_URL: string
  EXECUTOR_INSTALL_ID: string
  EXECUTOR_INSTALL_BOOTSTRAP: string
  EXECUTOR_INSTALL_MODE: ExecutorInstallMode
  EXECUTOR_INSTALL_ROOT: string
  EXECUTOR_INSTALL_LABEL?: string
}

export type ExecutorUpdateAssets = {
  manifestUrl: string
  publicKey: string
}

export function bootstrapEnvironment(env: NodeJS.ProcessEnv): BootstrapEnvironment {
  const required = (name: keyof BootstrapEnvironment): string => {
    const value = env[name]?.trim()
    if (!value || value.includes('\0')) throw new Error(`Missing or invalid ${name}`)
    return value
  }
  const mode = required('EXECUTOR_INSTALL_MODE')
  if (mode !== 'service' && mode !== 'temporary') throw new Error('Invalid EXECUTOR_INSTALL_MODE')
  return {
    HOST_URL: required('HOST_URL'), EXECUTOR_INSTALL_ID: required('EXECUTOR_INSTALL_ID'),
    EXECUTOR_INSTALL_BOOTSTRAP: required('EXECUTOR_INSTALL_BOOTSTRAP'), EXECUTOR_INSTALL_MODE: mode,
    EXECUTOR_INSTALL_ROOT: required('EXECUTOR_INSTALL_ROOT'),
    ...(env.EXECUTOR_INSTALL_LABEL?.trim() ? { EXECUTOR_INSTALL_LABEL: env.EXECUTOR_INSTALL_LABEL.trim() } : {}),
  }
}

export async function installationRequest<T>(env: BootstrapEnvironment, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${env.HOST_URL.replace(/\/$/u, '')}/install/session/${encodeURIComponent(env.EXECUTOR_INSTALL_ID)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.EXECUTOR_INSTALL_BOOTSTRAP}`, ...init.headers },
  })
  if (!response.ok) throw new Error(`installation request failed: ${response.status} ${await response.text()}`)
  return await response.json() as T
}

export async function reportInstallation(env: BootstrapEnvironment, status: string, metadata?: Record<string, unknown>): Promise<ExecutorInstallStatusSnapshot> {
  return await installationRequest(env, '/events', { method: 'POST', body: JSON.stringify({ status, ...(metadata ? { metadata } : {}) }) })
}

export async function waitForApproval(env: BootstrapEnvironment, intervalMs = 1_000): Promise<void> {
  while (true) {
    const snapshot = await installationRequest<ExecutorInstallStatusSnapshot>(env, '/status')
    if (snapshot.status === 'paired') return
    if (snapshot.status === 'rejected' || snapshot.status === 'expired' || snapshot.status === 'failed') throw new Error(`installation ${snapshot.status}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export async function redeemInstallation(env: BootstrapEnvironment, workspaceId: string): Promise<{ token: string }> {
  return await installationRequest(env, '/redeem', { method: 'POST', body: JSON.stringify({ workspaceId, ...(env.EXECUTOR_INSTALL_LABEL ? { label: env.EXECUTOR_INSTALL_LABEL } : {}) }) })
}

export async function downloadExecutorUpdateAssets(hostUrl: string): Promise<ExecutorUpdateAssets | undefined> {
  const assetsUrl = `${hostUrl.replace(/\/$/u, '')}/install/assets`
  const manifestUrl = `${assetsUrl}/executor-update-manifest.json`
  const publicKeyUrl = `${assetsUrl}/executor-update-public-key.pem`
  const [manifestResponse, publicKeyResponse] = await Promise.all([fetch(manifestUrl), fetch(publicKeyUrl)])
  if (manifestResponse.status === 404 && publicKeyResponse.status === 404) return undefined
  if (!manifestResponse.ok) throw new Error(`failed to download Executor update manifest: ${manifestResponse.status}`)
  if (!publicKeyResponse.ok) throw new Error(`failed to download Executor update verification key: ${publicKeyResponse.status}`)
  return { manifestUrl, publicKey: await publicKeyResponse.text() }
}

export function writeInstallerSession(path: string, session: InstallerSession): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

export function defaultManagedRoot(home: string, system: boolean): string {
  return system ? '/var/lib/runlab-executor' : join(home, '.local', 'state', 'runlab-executor')
}
