import { createServer, get, type Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Server as SocketIOServer } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'

import { createRuntimeUnitIngress } from './runtime-unit-ingress.js'

const servers: HttpServer[] = []
const ios: SocketIOServer[] = []
const sockets: Socket[] = []

async function listen(server: HttpServer): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server has no port')
  return address.port
}

async function unit(id: string): Promise<{ origin: string; io: SocketIOServer }> {
  const http = createServer((request, response) => {
    response.end(`unit:${id}:${request.url}`)
  })
  const io = new SocketIOServer(http, { serveClient: false, connectionStateRecovery: { maxDisconnectionDuration: 5_000 } })
  ios.push(io)
  io.on('connection', (socket) => socket.on('identify', (ack) => ack(id)))
  return { origin: `http://127.0.0.1:${await listen(http)}`, io }
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const io of ios.splice(0)) io.engine.close()
  for (const server of servers.splice(0)) {
    if (!server.listening) continue
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('RuntimeUnitIngress', () => {
  it.each(['polling', 'websocket'] as const)('routes independent %s Socket.IO and ACK traffic', async (transport) => {
    const a = await unit('a')
    const b = await unit('b')
    const ingress = createServer()
    const router = createRuntimeUnitIngress({
      isRoutableRequest: (request) => request.url?.startsWith('/socket.io') ?? false,
      resolve: (request) => request.headers['x-runtime-unit'] === 'a'
        ? { unitId: 'a', origin: a.origin }
        : request.headers['x-runtime-unit'] === 'b' ? { unitId: 'b', origin: b.origin } : undefined,
    })
    router.attach(ingress)
    const url = `http://127.0.0.1:${await listen(ingress)}`

    const socketA = connect(url, { transports: [transport], extraHeaders: { 'x-runtime-unit': 'a' }, forceNew: true })
    const socketB = connect(url, { transports: [transport], extraHeaders: { 'x-runtime-unit': 'b' }, forceNew: true })
    sockets.push(socketA, socketB)
    await Promise.all([socketA, socketB].map((socket) => new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
    })))

    await expect(socketA.timeout(2_000).emitWithAck('identify')).resolves.toBe('a')
    await expect(socketB.timeout(2_000).emitWithAck('identify')).resolves.toBe('b')

    router.close()
  })

  it('closes one internal Unit without stopping ingress or another Unit', async () => {
    const a = await unit('a')
    const b = await unit('b')
    const ingress = createServer()
    const router = createRuntimeUnitIngress({
      isRoutableRequest: (request) => request.url?.startsWith('/socket.io') ?? false,
      resolve: (request) => ({ unitId: String(request.headers['x-runtime-unit']), origin: request.headers['x-runtime-unit'] === 'a' ? a.origin : b.origin }),
    })
    router.attach(ingress)
    const url = `http://127.0.0.1:${await listen(ingress)}`

    await new Promise<void>((resolve) => a.io.close(() => resolve()))
    const socketB = connect(url, { transports: ['websocket'], extraHeaders: { 'x-runtime-unit': 'b' }, forceNew: true })
    sockets.push(socketB)
    await new Promise<void>((resolve, reject) => {
      socketB.once('connect', resolve)
      socketB.once('connect_error', reject)
    })
    await expect(socketB.timeout(2_000).emitWithAck('identify')).resolves.toBe('b')
    expect(ingress.listening).toBe(true)
    router.close()
  })

  it('fails unknown HTTP routes closed without reaching a Unit', async () => {
    const ingress = createServer()
    const router = createRuntimeUnitIngress({ resolve: () => undefined })
    router.attach(ingress)
    const port = await listen(ingress)
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      get(`http://127.0.0.1:${port}/socket.io`, (response) => {
        let body = ''
        response.on('data', (chunk) => { body += String(chunk) })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      }).on('error', reject)
    })
    expect(result.status).toBe(404)
    expect(result.body).toContain('TENANT_RUNTIME_UNIT_NOT_FOUND')
    router.close()
  })
})
