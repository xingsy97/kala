/**
 * "Hidden sessions" UI preference — a purely local filter that removes a
 * session from the Explorer sidebar tree (mirrors hidden-workspaces). Hiding
 * never touches server/session state. Backed by {@link useHiddenIds} keyed on
 * PREF_HIDDEN_SESSIONS.
 */

import { PREF_HIDDEN_SESSIONS } from '../../lib/prefs.js'
import { useHiddenIds, type UseHiddenIds } from './hidden-ids.js'

export type UseHiddenSessions = UseHiddenIds

export function useHiddenSessions(): UseHiddenSessions {
  return useHiddenIds(PREF_HIDDEN_SESSIONS)
}
