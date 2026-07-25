import type { ServerHistoryPayload } from '@agent-kernel/shared'
import { useEffect, useState } from 'react'

import type { DashboardSocket, TimelineEntry } from '../../session.js'

/** Loads a session's historical timeline over the socket (inspector). */

export type HistoryTimelineState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; timeline: readonly TimelineEntry[] }
  | { status: 'unavailable' }

export function useHistoryTimeline(socket: DashboardSocket | null, sessionId: string | null): HistoryTimelineState {
  const [state, setState] = useState<HistoryTimelineState>({ status: 'idle' })

  useEffect(() => {
    if (!socket || !sessionId) {
      setState({ status: 'idle' })
      return
    }
    setState({ status: 'loading' })
    const onHistory = (p: ServerHistoryPayload): void => {
      if (p.sessionId !== sessionId) return
      const timeline = p.entries.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          event: e.event,
          effects: e.effects,
          ...(e.hasEffectsArtifact ? { hasEffectsArtifact: true } : {}),
          ...(e.hasLlmTraceArtifact ? { hasLlmTraceArtifact: true } : {}),
          ...(e.llmTrace ? { llmTrace: e.llmTrace } : {}),
          ...(e.model ? { model: e.model } : {}),
        }))
      setState(timeline.length > 0 ? { status: 'ready', timeline } : { status: 'unavailable' })
    }
    socket.on('server:history', onHistory)
    socket.emit('client:load_history', { sessionId })
    return () => {
      socket.off('server:history', onHistory)
    }
  }, [socket, sessionId])

  return state
}
