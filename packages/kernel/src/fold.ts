/**
 * Replay: fold an event log back into a state.
 *
 * Because `step` is pure, `fold` is just `events.reduce(step, initialState)`.
 * The effects produced during replay are discarded — the host already performed
 * them the first time around. If you want to *replay effects too* (e.g. for
 * debugging), inspect them via `foldWithTrace`.
 */

import { step } from './core.js'
import type { AgentConfig, AgentEvent, AgentState, Effect } from './types.js'

export function fold(
  initial: AgentState,
  events: readonly AgentEvent[],
  config: AgentConfig,
): AgentState {
  let state = initial
  for (const ev of events) {
    state = step(state, ev, config).next
  }
  return state
}

export type TraceEntry = {
  cursor: number
  event: AgentEvent
  state: AgentState
  effects: readonly Effect[]
}

export function foldWithTrace(
  initial: AgentState,
  events: readonly AgentEvent[],
  config: AgentConfig,
): { final: AgentState; trace: TraceEntry[] } {
  const trace: TraceEntry[] = []
  let state = initial
  for (const ev of events) {
    const result = step(state, ev, config)
    state = result.next
    trace.push({
      cursor: state.cursor,
      event: ev,
      state,
      effects: result.effects,
    })
  }
  return { final: state, trace }
}

/**
 * Fork: fold up to a cursor, then continue with new events.
 * Used by the dashboard's "fork from step N" feature.
 */
export function fork(
  initial: AgentState,
  originalEvents: readonly AgentEvent[],
  cursor: number,
  newEvents: readonly AgentEvent[],
  config: AgentConfig,
): AgentState {
  const kept = originalEvents.slice(0, cursor)
  return fold(initial, [...kept, ...newEvents], config)
}
