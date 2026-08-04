import { createServer } from 'node:http'

const port = Number(process.env.SERVICE_PORT ?? 18081)
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const body = pathname === '/health' ? { status: 'ok' } : pathname === '/version' ? { version: 'v1' } : { error: 'not_found' }
  response.writeHead(pathname === '/health' || pathname === '/version' ? 200 : 404, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
})
server.listen(port, '127.0.0.1')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)))
