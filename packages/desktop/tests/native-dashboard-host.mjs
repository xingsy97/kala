// Isolated real Host + production Dashboard fixture. Never installs a fake bridge.
// Run with the workspace's existing tsx runner, only inside the native builder.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { hostname } from 'node:os'
import { startHostServer } from '../../host/src/server.ts'
import { createConfig } from '../../kernel/src/index.ts'

assert.equal(hostname(), 'runlab-desktop-builder')
const root = resolve(import.meta.dirname, '../../..')
const output = process.env.RUNLAB_DESKTOP_EVIDENCE
assert(output && process.env.RUNLAB_DESKTOP_PROBE_ORIGIN)
const config = createConfig({ systemPrompt: 'Isolated native acceptance; no prompts.', tools: [] })
const http = createServer()
await new Promise(done => http.listen(0, '127.0.0.1', done))
const records = []
const heldBaselines = new Set()
let sequence = 100
const host = await startHostServer({
  httpServer: http, port: http.address().port, sessionsDir: resolve(output, 'host-state'),
  artifactRootDir: false, defaultConfig: config, copilot: { enabled: false },
  settings: { providers: [], defaultModel: '', hooks: [],
    paths: { claudeSettings: 'fixture', codexConfig: 'fixture', manualModels: 'fixture', hooksConfig: 'fixture', sessionsDir: 'fixture' },
    mcp: { supported: false, note: 'Native acceptance fixture' } },
  llm: { name: 'no-model-calls', async call() { throw new Error('Native acceptance must never send a prompt') } },
  dashboardHandler(req, res) {
    void (async () => {
      const path = new URL(req.url, 'http://localhost').pathname
      if (path === '/__native/baseline' && req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const { sessionId, hold } = JSON.parse(Buffer.concat(chunks))
        assert.equal(sessionId, 'session-cpu')
        if (hold) heldBaselines.add(sessionId)
        else heldBaselines.delete(sessionId)
        res.writeHead(204); res.end()
        return
      }
      if (['/commands', '/checks', '/feature-checks', '/probe.js'].includes(path)
          || path === '/downloads/desktop/release.json'
          || (req.method === 'HEAD' && path.startsWith('/downloads/desktop/99.'))
          || (req.method === 'HEAD' && path.startsWith('/downloads/desktop/kala-desktop_99.'))) {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const reply = await fetch(`${process.env.RUNLAB_DESKTOP_PROBE_ORIGIN}${path}`, {
          method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        })
        res.writeHead(reply.status, { 'Content-Type': reply.headers.get('content-type') ?? 'application/json' })
        res.end(Buffer.from(await reply.arrayBuffer()))
        return
      }
      if (path === '/__native/change' && req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const { sessionId, status } = JSON.parse(Buffer.concat(chunks))
        const record = records.find(item => item.sessionId === sessionId)
        assert(record && ['idle', 'thinking', 'done', 'awaiting_approval', 'error'].includes(status))
        record.state = { ...record.state, status, cursor: ++sequence }
        host.io.of('/dashboard').to(`session:${sessionId}`).emit('state:changed', { sessionId, state: record.state, cursor: sequence })
        host.io.of('/dashboard').emit('server:sessions', { sessions: records.map(item => ({
          sessionId: item.sessionId, agentRuntime: 'kernel', createdAt: '2026-09-15T00:00:00Z',
          status: item.state.status, eventCount: sequence, label: item.label, queuedCount: 0,
        })) })
        res.writeHead(204); res.end()
        return
      }
      if (path === '/') {
        const html = readFileSync(resolve(root, 'packages/dashboard/dist/index.html'), 'utf8')
          .replace('<head>', `<head><script>localStorage.setItem('ak-dashboard-language','en');localStorage.setItem('ak-desktop-notifications-enabled','true');localStorage.setItem('ak-desktop-notification-details','false');localStorage.setItem('ak-desktop-notification-sound','false');if(!location.search)history.replaceState(null,'','/?sessionId=session-viewed');</script><script src="/probe.js"></script>`)
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html)
        return
      }
      const directory = resolve(root, 'packages/dashboard/dist')
      const file = resolve(directory, `.${decodeURIComponent(path)}`)
      if (!file.startsWith(`${directory}/`)) { res.writeHead(403); res.end(); return }
      let body
      try { body = readFileSync(file) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        res.writeHead(404); res.end(); return
      }
      res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    })().catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)) })
  },
})
host.io.of('/dashboard').on('connection', socket => {
  const emit = socket.emit.bind(socket)
  socket.emit = (event, ...args) => {
    if (event === 'session:ready' && heldBaselines.has(args[0]?.sessionId)) return true
    return emit(event, ...args)
  }
})
for (const sessionId of ['session-viewed', 'session-other', 'session-link', 'session-approval', 'session-complete', 'cold-session', 'session-cpu']) {
  const record = await host.store.create({ sessionId, config })
  await host.store.rename(sessionId, `Private ${sessionId}`)
  records.push(record)
}
writeFileSync(resolve(output, 'host-origin'), `http://127.0.0.1:${host.port}`)
const stop = async () => { await host.close(); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
