/**
 * Workspace identity. A workspace = one machine (see ADR 0014).
 *
 * Identity is a ULID persisted to `~/.agent-kernel/workspace-id` on first
 * launch, then read verbatim on every subsequent launch. Sessions bind to
 * this ID in their JSONL header — renaming the workspace (via `--name`)
 * changes only the display label; routing stays intact.
 *
 * We deliberately do NOT use `os.hostname()` or `/etc/machine-id` as the
 * primary ID: the former is user-mutable, the latter is per-machine (not
 * per-user) so two users on the same host would share a workspace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ulid } from 'ulid'

export const WORKSPACE_ID_ENV = 'AGENT_KERNEL_WORKSPACE_ID_FILE'

export function workspaceIdPath(): string {
  const override = process.env[WORKSPACE_ID_ENV]
  if (override && override.length > 0) return override
  return join(homedir(), '.agent-kernel', 'workspace-id')
}

/**
 * Load the workspace id, minting one on first run. Idempotent: multiple
 * calls in the same process return the same id, and multiple executor
 * processes on the same machine (same user) all resolve to the same file.
 *
 * Throws if the file exists but is not a well-formed ULID — a corrupted
 * id would silently detach this machine's sessions on next start, which
 * is worse than failing loudly.
 */
export function loadOrCreateWorkspaceId(pathOverride?: string): string {
  const path = pathOverride ?? workspaceIdPath()
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim()
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw)) {
      throw new Error(
        `Invalid workspace id at ${path}: ${JSON.stringify(raw)}. Delete the file to regenerate (WARNING: existing sessions bound to the old id will detach).`,
      )
    }
    return raw
  }
  const id = ulid()
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir.length > 0) mkdirSync(dir, { recursive: true })
  writeFileSync(path, id + '\n', { encoding: 'utf8', mode: 0o600 })
  return id
}
