import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import { dirname } from 'node:path'

export type ExecutorUpdateStatus = {
  version: string
  workspaceId: string
  connected: boolean
  draining: boolean
  activeTools: number
  activeTerminals: number
}

export type ExecutorUpdateControl = {
  socketPath: string
  status(): ExecutorUpdateStatus
  beginDrain(): void
  resume(): void
}

export async function startUpdateControlServer(control: ExecutorUpdateControl): Promise<{ close(): Promise<void> }> {
  if (process.platform === 'win32') throw new Error('Unix update control socket is unavailable on Windows')
  await mkdir(dirname(control.socketPath), { recursive: true, mode: 0o700 })
  await rm(control.socketPath, { force: true })
  const server = createServer((socket) => handleConnection(socket, control))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(control.socketPath, () => { server.off('error', reject); resolve() })
  })
  await chmod(control.socketPath, 0o600)
  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(control.socketPath, { force: true })
    },
  }
}

function handleConnection(socket: Socket, control: ExecutorUpdateControl): void {
  socket.setEncoding('utf8')
  let input = ''
  socket.on('data', (chunk: string) => {
    input += chunk
    if (input.length > 4096) { socket.destroy(); return }
    const newline = input.indexOf('\n')
    if (newline < 0) return
    const command = input.slice(0, newline).trim()
    if (command === 'drain') control.beginDrain()
    if (command === 'resume') control.resume()
    if (command !== 'status' && command !== 'drain' && command !== 'resume') {
      socket.end(`${JSON.stringify({ ok: false, error: 'unknown command' })}\n`)
      return
    }
    socket.end(`${JSON.stringify({ ok: true, status: control.status() })}\n`)
  })
}

export async function requestUpdateControl(socketPath: string, command: 'status' | 'drain' | 'resume', timeoutMs = 5_000): Promise<ExecutorUpdateStatus> {
  return await new Promise((resolve, reject) => {
    const socket = new Socket()
    let data = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`update control timed out after ${timeoutMs}ms`)) }, timeoutMs)
    const fail = (error: Error): void => { clearTimeout(timer); socket.destroy(); reject(error) }
    socket.once('error', fail)
    socket.connect(socketPath, () => socket.write(`${command}\n`))
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { data += chunk })
    socket.once('end', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(data) as { ok?: boolean; error?: string; status?: ExecutorUpdateStatus }
        if (!parsed.ok || !parsed.status) throw new Error(parsed.error ?? 'invalid update control response')
        resolve(parsed.status)
      } catch (error) { reject(error) }
    })
  })
}
