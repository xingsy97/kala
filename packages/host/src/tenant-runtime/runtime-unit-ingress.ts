import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import httpProxy from 'http-proxy'

export type RuntimeProxyTarget = {
  readonly unitId: string
  readonly origin: string
}

export type ResolveRuntimeProxyTarget = (
  request: IncomingMessage,
) => RuntimeProxyTarget | undefined | Promise<RuntimeProxyTarget | undefined>

export type RuntimeUnitIngress = {
  attach(server: HttpServer): void
  close(): void
}

/**
 * Routes public HTTP and WebSocket-upgrade traffic to a TenantRuntimeUnit's
 * private HTTP listener. Authentication and user-to-unit mapping stay outside
 * this router; the resolver receives an already trusted ingress request.
 */
export function createRuntimeUnitIngress(options: {
  resolve: ResolveRuntimeProxyTarget
  isRoutableRequest?: (request: IncomingMessage) => boolean
}): RuntimeUnitIngress {
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, changeOrigin: false })
  const isRoutable = options.isRoutableRequest ?? (() => true)
  let attached: HttpServer | undefined

  const rejectHttp = (response: ServerResponse, status: number, message: string): void => {
    if (response.headersSent) return
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: message }))
  }
  const rejectUpgrade = (socket: Duplex, status: number, message: string): void => {
    if (!socket.writable) return
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (!isRoutable(request) || response.writableEnded) return
    void Promise.resolve(options.resolve(request)).then((target) => {
      if (!target) {
        rejectHttp(response, 404, 'TENANT_RUNTIME_UNIT_NOT_FOUND')
        return
      }
      proxy.web(request, response, { target: target.origin }, (error) => {
        rejectHttp(response, 502, error instanceof Error ? error.message : 'TENANT_RUNTIME_UNIT_UNAVAILABLE')
      })
    }).catch(() => rejectHttp(response, 503, 'TENANT_RUNTIME_UNIT_UNAVAILABLE'))
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isRoutable(request)) return
    void Promise.resolve(options.resolve(request)).then((target) => {
      if (!target) {
        rejectUpgrade(socket, 404, 'Not Found')
        return
      }
      proxy.ws(request, socket, head, { target: target.origin }, (error) => {
        rejectUpgrade(socket, 502, error instanceof Error ? error.message : 'Bad Gateway')
      })
    }).catch(() => rejectUpgrade(socket, 503, 'Service Unavailable'))
  }

  return {
    attach(server) {
      if (attached === server) return
      if (attached) throw new Error('RuntimeUnitIngress is already attached')
      attached = server
      // Prepend so the router claims Unit paths before static/API fallbacks.
      server.prependListener('request', onRequest)
      server.prependListener('upgrade', onUpgrade)
    },
    close() {
      if (attached) {
        attached.removeListener('request', onRequest)
        attached.removeListener('upgrade', onUpgrade)
        attached = undefined
      }
      proxy.close()
    },
  }
}
