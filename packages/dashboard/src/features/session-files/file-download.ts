import { downloadBlob } from '../../lib/save-file.js'

type DownloadableFileResult =
  | { kind: 'text'; content: string; truncated?: boolean }
  | { kind: 'image' | 'pdf' | 'video'; content: string; mediaType: string; truncated?: boolean }
  | { kind: 'binary'; content?: string; mediaType?: string; truncated?: boolean }

export function fileResultDownloadBlob(result: DownloadableFileResult): { blob: Blob } | undefined {
  if (result.kind === 'text') {
    if (result.truncated) return undefined
    return { blob: new Blob([result.content], { type: 'text/plain;charset=utf-8' }) }
  }
  if (result.truncated) return undefined
  if (result.kind === 'image' || result.kind === 'pdf' || result.kind === 'video') return { blob: base64Blob(result.content, result.mediaType) }
  if (result.kind === 'binary' && result.content) return { blob: base64Blob(result.content, result.mediaType ?? 'application/octet-stream') }
  return undefined
}

export function saveBlob(blob: Blob, filename: string): void {
  downloadBlob(blob, filename)
}

export function downloadFilename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? 'download'
}

function base64Blob(content: string, mediaType: string): Blob {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mediaType })
}
