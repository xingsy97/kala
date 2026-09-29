import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import { connect, type Socket } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { parsePublicUrls } from '@agent-kernel/shared'

import { attachPublicAccessGate } from './public-access-gate.js'

const servers: HttpServer[] = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(servers.splice(0).map(async (server) => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }))
})

describe('public access HTTP gate', () => {
  it('runs before existing request handlers and exposes the validated origin', async () => {
    const server = createServer((request, response) => {
      if (response.writableEnded) return
      response.end(String(request.headers['x-kala-public-origin']))
    })
    attachPublicAccessGate(server, parsePublicUrls('http://*:13000,https://agent.example.test'))
    const port = await listen(server)

    await expect(call(port, 'workspace.example.test:13000', 'http://workspace.example.test:13000')).resolves.toEqual({
      status: 200,
      body: 'http://workspace.example.test:13000',
    })
    await expect(call(port, 'agent.example.test', 'https://agent.example.test')).resolves.toEqual({
      status: 200,
      body: 'https://agent.example.test',
    })
  })

  it('rejects disallowed hosts and cross-origin requests before routing', async () => {
    let routed = 0
    const server = createServer((_request, response) => {
      if (response.writableEnded) return
      routed += 1
      response.end('routed')
    })
    attachPublicAccessGate(server, parsePublicUrls('http://127.0.0.1:13000'))
    const port = await listen(server)

    await expect(call(port, 'other.local:13000')).resolves.toMatchObject({ status: 400 })
    await expect(call(port, '127.0.0.1:13000', 'https://evil.example')).resolves.toMatchObject({ status: 403 })
    expect(routed).toBe(0)
  })

  it('rejects a WebSocket upgrade before later upgrade handlers run', async () => {
    let upgraded = false
    const server = createServer()
    server.on('upgrade', (_request, socket) => {
      if (!socket.writable || socket.writableEnded) return
      upgraded = true
      socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n')
    })
    attachPublicAccessGate(server, parsePublicUrls('http://127.0.0.1:13000'))
    const port = await listen(server)
    const socket = connect(port, '127.0.0.1')
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const response = new Promise<string>((resolve) => socket.once('data', (chunk) => resolve(String(chunk))))
    socket.write('GET /socket.io/ HTTP/1.1\r\nHost: evil.example:13000\r\nOrigin: http://evil.example:13000\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')

    await expect(response).resolves.toContain('400 Bad Request')
    expect(upgraded).toBe(false)
  })
})

async function listen(server: HttpServer): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server has no TCP address')
  return address.port
}

function call(port: number, host: string, origin?: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/healthz',
      headers: { host, ...(origin ? { origin } : {}) },
    }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += String(chunk) })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.once('error', reject)
    request.end()
  })
}
