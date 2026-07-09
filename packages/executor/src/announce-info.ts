/**
 * Machine metadata gathered at executor start-up and included in
 * `executor:announce`. Kept in its own file because none of it depends on
 * the socket / tool registry — pure derivations from `node:os`.
 */

import { networkInterfaces } from 'node:os'

import type { ExecutorOs } from '@agent-kernel/shared'

export function normalizeOs(p: NodeJS.Platform): ExecutorOs {
  if (p === 'linux' || p === 'darwin' || p === 'win32') return p
  return 'other'
}

/**
 * All non-loopback, non-link-local addresses this executor is reachable at.
 * Purely informational — shown in the dashboard's Workspaces column and
 * Machine Details drawer.
 */
export function collectIpAddresses(): string[] {
  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    if (!list) continue
    for (const addr of list) {
      if (addr.internal) continue
      if (addr.family === 'IPv6' && addr.address.startsWith('fe80')) continue
      out.push(addr.address)
    }
  }
  return out
}
