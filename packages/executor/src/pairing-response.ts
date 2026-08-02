export async function readPairingJson<T>(response: Response, action: string, url: string): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const body = await response.text()
  const html = contentType.includes('text/html') || /^\s*<!doctype html|^\s*<html/iu.test(body)
  if ((response.status >= 300 && response.status < 400) || html) {
    throw new Error(`Unable to ${action}: the server returned a sign-in page instead of JSON. Allow unauthenticated access to /auth/executor-pairings and /auth/executor-pairings/* in the proxy or Cloudflare Access policy, then retry. (${url})`)
  }
  if (!response.ok) throw new Error(`Unable to ${action}: server returned HTTP ${response.status}${body.trim() ? ` — ${body.trim().slice(0, 200)}` : ''}`)
  if (!contentType.includes('application/json')) throw new Error(`Unable to ${action}: expected JSON but received ${contentType || 'an unknown content type'}. Check the proxy route for ${url}.`)
  try { return JSON.parse(body) as T } catch { throw new Error(`Unable to ${action}: the server returned invalid JSON. Check the proxy route for ${url}.`) }
}
