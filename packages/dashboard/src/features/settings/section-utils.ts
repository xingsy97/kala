/**
 * Pure formatting/parsing helpers used across Settings sections. No React, no
 * side effects — extracted from SettingsDialog so they can be unit-tested and
 * reused by the per-section modules.
 */

import { resolveHostEndpoint } from '../../host-endpoint.js'

/** The shell command an operator runs to attach a new executor with an invite. */
export function executorSetupCommand(inviteToken: string): string {
  const hostUrl = resolveHostEndpoint().url
  return `HOST_URL=${shellQuote(hostUrl)} EXECUTOR_INVITE=${shellQuote(inviteToken)} SANDBOX_ROOTS="$HOME" agent-kernel-executor`
}

/** Extract a human error string from an unknown JSON error body, or null. */
export function errorMessageFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0 ? error : null
}

/** Read an error message from a failed fetch Response (JSON `error` or status). */
export async function responseError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string }
    return body.error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

/**
 * A user-provided invite label, or undefined when it is empty or the generic
 * placeholder ("connect workspace") that carries no information.
 */
export function meaningfulInviteLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim()
  if (!trimmed) return undefined
  if (trimmed.toLocaleLowerCase() === 'connect workspace') return undefined
  return trimmed
}

/** Single-quote a value for safe shell interpolation. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Human-readable byte size (B / KB / MB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Locale date-time string, or the raw value when unparseable. */
export function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}
