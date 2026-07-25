import { PREF_SESSION_CHILDREN_OPEN, PREF_SESSION_ORDER, PREF_WORKSPACE_OPEN, PREF_WORKSPACE_ORDER } from '../../lib/prefs.js'

/** LocalStorage persistence for explorer open-state + ordering (pure I/O). */

const SESSION_ORDER_STORAGE_KEY = PREF_SESSION_ORDER
const WORKSPACE_ORDER_STORAGE_KEY = PREF_WORKSPACE_ORDER
const WORKSPACE_OPEN_STORAGE_KEY = PREF_WORKSPACE_OPEN
const SESSION_CHILDREN_OPEN_STORAGE_KEY = PREF_SESSION_CHILDREN_OPEN

export function readStoredWorkspaceOpenState(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_OPEN_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('ws:') && typeof value === 'boolean') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export function writeStoredWorkspaceOpenState(state: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(WORKSPACE_OPEN_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

export function readStoredSessionChildrenOpenState(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(SESSION_CHILDREN_OPEN_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('sess:') && typeof value === 'boolean') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export function writeStoredSessionChildrenOpenState(state: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(SESSION_CHILDREN_OPEN_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

export function readStoredWorkspaceOrder(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_ORDER_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
  } catch {
    return []
  }
}

export function writeStoredWorkspaceOrder(order: readonly string[]): void {
  try {
    window.localStorage.setItem(WORKSPACE_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

export function readStoredSessionOrder(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(SESSION_ORDER_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
  } catch {
    return []
  }
}

export function writeStoredSessionOrder(order: readonly string[]): void {
  try {
    window.localStorage.setItem(SESSION_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}
