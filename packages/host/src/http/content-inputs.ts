import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const MAX_UPLOAD_CONTENT_BYTES = 20 * 1024 * 1024
const SAFE_FIELD_PATTERN = /^[A-Za-z0-9._-]+$/

export type ContentInput = {
  path?: string
  content?: string
  sessionId?: string
}

export interface ResolveContentToPathOptions {
  action: string
  field: string
  extension: string
  rootDir: string
  maxBytes?: number
  sessionResolver?: (sessionId: string) => Promise<string>
}

export class ContentInputError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(message: string, options: { code: string; httpStatus: number }) {
    super(message)
    this.name = 'ContentInputError'
    this.code = options.code
    this.httpStatus = options.httpStatus
  }
}

export async function resolveContentToPath(
  input: ContentInput,
  options: ResolveContentToPathOptions,
): Promise<string> {
  const { action, field, extension, rootDir, maxBytes = MAX_UPLOAD_CONTENT_BYTES, sessionResolver } = options
  const explicit = cleanString(input.path)
  if (explicit) return explicit

  if (input.content !== undefined) {
    if (typeof input.content !== 'string') {
      throw new ContentInputError(`${field} content must be a string`, {
        code: 'content_invalid_type',
        httpStatus: 400,
      })
    }
    const bytes = Buffer.byteLength(input.content, 'utf8')
    if (bytes > maxBytes) {
      throw new ContentInputError(`${field} content is ${bytes} bytes, exceeds ${maxBytes}`, {
        code: 'content_too_large',
        httpStatus: 413,
      })
    }
    if (!SAFE_FIELD_PATTERN.test(field)) {
      throw new ContentInputError(`${field} is not a safe field name`, {
        code: 'content_unsafe_field',
        httpStatus: 400,
      })
    }
    if (!SAFE_FIELD_PATTERN.test(action)) {
      throw new ContentInputError(`${action} is not a safe action name`, {
        code: 'content_unsafe_action',
        httpStatus: 400,
      })
    }
    const safeExt = normalizeExtension(extension)
    const uuid = randomUUID()
    const dir = join(rootDir, 'uploads', action, uuid)
    await mkdir(dir, { recursive: true })
    const dest = join(dir, `${field}${safeExt}`)
    await writeFile(dest, input.content, 'utf8')
    return dest
  }

  const sessionId = cleanString(input.sessionId)
  if (sessionId && sessionResolver) {
    return await sessionResolver(sessionId)
  }

  throw new ContentInputError(
    `${field} is required (provide ${field}Path or ${field}Content${sessionResolver ? ' or sessionId' : ''})`,
    { code: 'content_missing', httpStatus: 400 },
  )
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeExtension(value: string): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}
