import { createServer, type Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Server as SocketIOServer } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'

const sockets: Socket[] = []
const servers: HttpServer[] = []

async function listen(server: HttpServer): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server port')
  return address.port
}

async function connected(url: string, path: string, transports: Array<'polling' | 'websocket'>): Promise<Socket> {
  const socket = connect(url, { path, transports, forceNew: true, reconnection: false })
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connection timeout for ${path}`)), 3_000)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
  })
  return socket
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const server of servers.splice(0)) {
    if (!server.listening) continue
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('Socket.IO shared HTTP server feasibility gate', () => {
  it('distinct paths can incidentally carry polling, websocket and ACK while both instances stay attached', async () => {
    const http = createServer()
    const a = new SocketIOServer(http, { path: '/unit-a/socket.io', serveClient: false, destroyUpgrade: false })
    const b = new SocketIOServer(http, { path: '/unit-b/socket.io', serveClient: false, destroyUpgrade: false })
    a.on('connection', (socket) => socket.on('identify', (ack) => ack('a')))
    b.on('connection', (socket) => socket.on('identify', (ack) => ack('b')))
    const port = await listen(http)
    const url = `http://127.0.0.1:${port}`

    for (const transport of ['polling', 'websocket'] as const) {
      const socketA = await connected(url, '/unit-a/socket.io', [transport])
      const socketB = await connected(url, '/unit-b/socket.io', [transport])
      await expect(socketA.timeout(2_000).emitWithAck('identify')).resolves.toBe('a')
      await expect(socketB.timeout(2_000).emitWithAck('identify')).resolves.toBe('b')
      socketA.close()
      socketB.close()
    }

    // Avoid io.close(): Socket.IO closes the supplied shared HTTP server.
    a.engine.close()
    b.engine.close()
  })

  it('proves io.close is not an independent Unit lifecycle operation', async () => {
    const http = createServer()
    const a = new SocketIOServer(http, { path: '/unit-a/socket.io', serveClient: false, destroyUpgrade: false })
    const b = new SocketIOServer(http, { path: '/unit-b/socket.io', serveClient: false, destroyUpgrade: false })
    b.on('connection', (socket) => socket.on('identify', (ack) => ack('b')))
    const port = await listen(http)
    const url = `http://127.0.0.1:${port}`
    const socketB = await connected(url, '/unit-b/socket.io', ['websocket'])
    await expect(socketB.timeout(2_000).emitWithAck('identify')).resolves.toBe('b')

    // Do not await the callback: Node waits for B's still-open upgraded socket,
    // which itself demonstrates that A cannot complete an independent close.
    a.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(http.listening).toBe(false)
    const replacement = connect(url, { path: '/unit-b/socket.io', transports: ['websocket'], forceNew: true, reconnection: false })
    sockets.push(replacement)
    await expect(new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500)
      replacement.once('connect', () => { clearTimeout(timer); reject(new Error('B unexpectedly accepted a new connection')) })
      replacement.once('connect_error', () => { clearTimeout(timer); resolve() })
    })).resolves.toBeUndefined()
    socketB.close()
    b.engine.close()
  })

  it('proves Engine.IO attachment has no detachable listener lifecycle', async () => {
    const http = createServer()
    const baseline = { request: http.listenerCount('request'), upgrade: http.listenerCount('upgrade') }
    const io = new SocketIOServer(http, { path: '/unit-a/socket.io', serveClient: false, destroyUpgrade: false })
    const attached = { request: http.listenerCount('request'), upgrade: http.listenerCount('upgrade') }
    expect(attached.request).toBeGreaterThan(baseline.request)
    expect(attached.upgrade).toBeGreaterThan(baseline.upgrade)

    io.engine.close()

    expect(http.listenerCount('request')).toBe(attached.request)
    expect(http.listenerCount('upgrade')).toBe(attached.upgrade)
  })
})
