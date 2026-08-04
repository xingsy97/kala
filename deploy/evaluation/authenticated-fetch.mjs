import { readFileSync } from 'node:fs'

const tokenFile = process.env.AGENT_EVAL_TOKEN_FILE
const controlPlaneUrl = process.env.AGENT_EVAL_URL
if (!tokenFile || !controlPlaneUrl) throw new Error('AGENT_EVAL_TOKEN_FILE and AGENT_EVAL_URL are required')

const token = readFileSync(tokenFile, 'utf8').trim()
if (!token) throw new Error('Control Plane bearer token file is empty')
const authority = new URL(controlPlaneUrl).origin
const originalFetch = globalThis.fetch

globalThis.fetch = (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== authority) return originalFetch(input, init)
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`)
  return originalFetch(input, { ...init, headers })
}
