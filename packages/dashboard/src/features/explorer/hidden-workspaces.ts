/**
 * Hidden-workspaces preference storage.
 *
 * A workspace can be "hidden" from the Explorer sidebar as a purely local UI
 * preference. Hiding does not touch executor data, sessions, or any server
 * state - it just filters what the sidebar tree renders. The preference lives
 * in localStorage under {@link HIDDEN_WORKSPACES_STORAGE_KEY} so it survives
 * reloads without a server round-trip and does not sync across devices.
 *
 * Wire format (`{ version: 1, ids: string[] }`) is guarded so bad/legacy JSON
 * degrades to "nothing hidden" rather than throwing during app boot.
 */

export const HIDDEN_WORKSPACES_STORAGE_KEY = 'ak-hidden-workspaces'

type StoredShape = { version: 1; ids: readonly string[] }

export function parseHiddenIds(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set<string>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set<string>()
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { ids?: unknown }).ids)
  ) {
    return new Set<string>()
  }
  const ids = (parsed as StoredShape).ids.filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  return new Set(ids)
}

export function serializeHiddenIds(ids: ReadonlySet<string>): string {
  const payload: StoredShape = { version: 1, ids: Array.from(ids) }
  return JSON.stringify(payload)
}
