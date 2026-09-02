import { TextDecoder } from 'node:util'

import type {
  Message,
  MessageContent,
  ReferencedFileContent,
} from '@agent-kernel/kernel'

import type { MessageAttachmentStore } from './message-attachment-store.js'

export function isReferencedFileContent(content: MessageContent): content is ReferencedFileContent {
  return content.type === 'file' && 'source' in content && content.source.kind === 'host_ref'
}

export function validateMessageAttachmentReferences(
  store: MessageAttachmentStore | undefined,
  sessionId: string,
  content: readonly MessageContent[] | undefined,
): void {
  for (const block of content ?? []) {
    if (!isReferencedFileContent(block)) continue
    if (!store) throw new Error(`Attachment "${block.name}" cannot be resolved because Host attachment storage is unavailable`)
    store.resolve(sessionId, block)
  }
}

export async function resolveKernelMessageAttachments(
  store: MessageAttachmentStore | undefined,
  sessionId: string,
  messages: readonly Message[],
): Promise<readonly Message[]> {
  let changed = false
  const resolved: Message[] = []
  for (const message of messages) {
    const content: MessageContent[] = []
    for (const block of message.content) {
      if (!isReferencedFileContent(block)) {
        content.push(block)
        continue
      }
      if (!store) throw new Error(`Attachment "${block.name}" cannot be resolved because Host attachment storage is unavailable`)
      const data = await store.resolve(sessionId, block).read()
      const text = decodeTextAttachment(block, data)
      content.push({
        type: 'text',
        text: `--- attached file: ${block.name} (${block.mediaType}) ---\n${text}\n--- end attached file: ${block.name} ---`,
      })
      changed = true
    }
    resolved.push(changed ? { ...message, content } : message)
  }
  return changed ? resolved : messages
}

export function assertKernelTextAttachment(file: Pick<ReferencedFileContent, 'name' | 'mediaType'>, data: Buffer): void {
  if (!isTextAttachment(file.mediaType, file.name) || containsBinaryBytes(data)) {
    throw new Error(`Kernel runtime cannot send binary attachment "${file.name}" (${file.mediaType}); use the Copilot runtime or attach a text-based file.`)
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new Error(`Kernel runtime cannot decode attachment "${file.name}" as UTF-8 text; use the Copilot runtime or attach a UTF-8 text file.`)
  }
}

function decodeTextAttachment(file: ReferencedFileContent, data: Buffer): string {
  assertKernelTextAttachment(file, data)
  return new TextDecoder('utf-8', { fatal: true }).decode(data)
}

export function isTextAttachment(mediaType: string, name: string): boolean {
  if (mediaType.startsWith('text/')) return true
  if ([
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/typescript',
    'application/sql',
  ].includes(mediaType)) return true
  return /\.(?:c|cc|cpp|cs|css|csv|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml)$/iu.test(name)
}

function containsBinaryBytes(data: Buffer): boolean {
  if (data.includes(0)) return true
  if (data.length === 0) return false
  let suspicious = 0
  for (const byte of data) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) suspicious += 1
  }
  return suspicious / data.length > 0.01
}
