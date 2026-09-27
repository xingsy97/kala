export function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`
}

export function terminalOwnerSessionId(sessionId: string): string | undefined {
  const prefix = 'workspace-terminal:'
  if (!sessionId.startsWith(prefix)) return sessionId
  const separator = sessionId.lastIndexOf(':')
  return separator > prefix.length ? sessionId.slice(prefix.length, separator) : undefined
}

export function terminalSessionRoom(sessionId: string): string | undefined {
  const ownerSessionId = terminalOwnerSessionId(sessionId)
  return ownerSessionId ? sessionRoom(ownerSessionId) : undefined
}
