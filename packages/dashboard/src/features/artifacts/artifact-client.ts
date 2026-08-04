import { resolveHostEndpoint } from '../../host-endpoint.js'

export type ArtifactClientOptions = {
  host?: string
  token?: string
}

let configuredOptions: ArtifactClientOptions = {}

export function configureArtifactClient(options: ArtifactClientOptions): void {
  configuredOptions = { ...options }
}

export function artifactUrl(path: string, options: ArtifactClientOptions = configuredOptions): string {
  const host = (options.host ?? resolveHostEndpoint().url).replace(/\/+$/u, '')
  return `${host}${path.startsWith('/') ? path : `/${path}`}`
}

export function artifactRequest(path: string, init: RequestInit = {}, options: ArtifactClientOptions = configuredOptions): Promise<Response> {
  const headers = new Headers(init.headers)
  if (options.token && !headers.has('authorization')) headers.set('authorization', `Bearer ${options.token}`)
  return fetch(artifactUrl(path, options), {
    ...init,
    headers,
    credentials: 'include',
  })
}

export async function downloadArtifact(path: string): Promise<void> {
  const response = await artifactRequest(`/artifacts/download?path=${encodeURIComponent(path)}`)
  if (!response.ok) throw new Error(`artifact download failed: ${response.status}`)
  const blobUrl = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = blobUrl
  link.download = path.split('/').at(-1) ?? 'artifact'
  link.click()
  URL.revokeObjectURL(blobUrl)
}
