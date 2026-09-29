import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { validatePublicRequest, type PublicUrlPattern } from '@agent-kernel/shared'

export const KALA_PUBLIC_ORIGIN_HEADER = 'x-kala-public-origin'

export function attachPublicAccessGate(server: HttpServer, publicUrls: readonly PublicUrlPattern[]): () => void {
  const validate = (request: IncomingMessage) => {
    delete request.headers[KALA_PUBLIC_ORIGIN_HEADER]
    const origin = singleHeader(request, 'origin')
    const decision = validatePublicRequest(publicUrls, request.headers.host, origin)
    if (decision.ok) request.headers[KALA_PUBLIC_ORIGIN_HEADER] = decision.origin
    return decision
  }
  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const decision = validate(request)
    if (decision.ok) return
    response.writeHead(decision.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: decision.error }))
  }
  const onUpgrade = (request: IncomingMessage, socket: Duplex): void => {
    const decision = validate(request)
    if (decision.ok) return
    socket.end(`HTTP/1.1 ${decision.status} ${decision.status === 400 ? 'Bad Request' : 'Forbidden'}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 0\r\n\r\n`)
  }
  server.prependListener('request', onRequest)
  server.prependListener('upgrade', onUpgrade)
  return () => {
    server.removeListener('request', onRequest)
    server.removeListener('upgrade', onUpgrade)
  }
}

export function validatedPublicOrigin(request: IncomingMessage): string | undefined {
  return singleHeader(request, KALA_PUBLIC_ORIGIN_HEADER)
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}
