import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { Message } from '@agent-kernel/kernel'
import type { SessionRecord } from './store/session.js'
import type { SessionArtifactRegistry } from './session-artifact-registry.js'

export type LocalImageReadResult = { base64?: string; mediaType?: string; size?: number; error?: string }
export type LocalImageReader = (input: { requestId: string; workspaceId: string; path: string; cwd?: string }) => Promise<LocalImageReadResult>

export function createLocalImagePublisher(deps: { reader: LocalImageReader; artifacts: SessionArtifactRegistry }) {
  return async (sessionId: string, record: SessionRecord, message: Message): Promise<Message> => {
    if (message.role !== 'assistant' || !record.workspaceId) return message
    const content = await Promise.all(message.content.map(async (part) => part.type === 'text'
      ? { ...part, text: await publishMarkdownImages(part.text, async (path, alt) => {
          const result = await deps.reader({ requestId: randomUUID(), workspaceId: record.workspaceId!, path, ...(record.state.cwd ? { cwd: record.state.cwd } : {}) })
          if (result.error || !result.base64 || !result.mediaType) return `[Image unavailable: ${alt || basename(path) || 'image'}]`
          try {
            const artifact = await deps.artifacts.registerImage({ sessionId, title: alt || basename(path), fileName: basename(path), data: Buffer.from(result.base64, 'base64') })
            return `![${escapeAlt(alt || artifact.title)}](artifact://${artifact.artifactId})`
          } catch { return `[Image unavailable: ${alt || basename(path) || 'image'}]` }
        }) }
      : part))
    return { ...message, content }
  }
}

export async function publishMarkdownImages(text: string, publish: (path: string, alt: string) => Promise<string>): Promise<string> {
  const chunks = text.split(/(```[\s\S]*?```)/g)
  for (let index = 0; index < chunks.length; index += 2) {
    const source = chunks[index] ?? ''
    const pattern = /!\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g
    let output = ''
    let cursor = 0
    for (const match of source.matchAll(pattern)) {
      output += source.slice(cursor, match.index)
      const raw = match[2]!.startsWith('<') ? match[2]!.slice(1, -1) : match[2]!
      output += isLocalImageReference(raw) ? await publish(decodeFileReference(raw), match[1]!) : match[0]
      cursor = match.index! + match[0].length
    }
    chunks[index] = output + source.slice(cursor)
  }
  return chunks.join('')
}

function isLocalImageReference(value: string): boolean {
  const lower = value.toLowerCase()
  return !/^(?:https?:|data:|blob:|artifact:)/.test(lower) && !value.startsWith('#')
}
function decodeFileReference(value: string): string {
  const raw = value.startsWith('file://') ? value.slice('file://'.length) : value
  try { return decodeURIComponent(raw) } catch { return raw }
}
function escapeAlt(value: string): string { return value.replace(/[\]\\]/g, '\\$&') }
