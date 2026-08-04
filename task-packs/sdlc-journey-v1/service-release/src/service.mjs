import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const releaseVersion = 'v1'

export function responseFor(pathname) {
  if (pathname === '/health') return { status: 200, body: { status: 'ok' } }
  if (pathname === '/version') return { status: 200, body: { version: releaseVersion } }
  return { status: 404, body: { error: 'not_found' } }
}

export function startService(port = Number(process.env.SERVICE_PORT ?? 18080)) {
  const server = createServer((request, response) => {
    const result = responseFor(new URL(request.url ?? '/', 'http://localhost').pathname)
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result.body))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startService()
  const stop = () => server.close(() => process.exit(0))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
