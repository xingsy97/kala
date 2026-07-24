import { readFile, stat } from 'node:fs/promises'

import { ToolError } from '../tools/registry.js'

export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024

export type LineEnding = 'lf' | 'crlf' | 'mixed'

export type LoadedTextFile = {
  readonly bytes: Uint8Array
  readonly text: string
  readonly body: string
  readonly bom: boolean
  readonly lineEnding: LineEnding
}

export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  if (crlf > 0 && lf > 0) return 'mixed'
  if (crlf > 0) return 'crlf'
  return 'lf'
}

export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
  if (ending !== 'crlf') return text
  return normalizeLineEndings(text).replaceAll('\n', '\r\n')
}

export function splitBom(text: string): { bom: boolean; text: string } {
  return text.startsWith('\uFEFF') ? { bom: true, text: text.slice(1) } : { bom: false, text }
}

export function joinBom(text: string, bom: boolean): string {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

export function isProbablyBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192))
  return sample.includes(0)
}

export async function loadTextFile(path: string): Promise<LoadedTextFile> {
  const s = await stat(path)
  if (s.isDirectory()) throw new ToolError('EISDIR', `path is a directory: ${path}`)
  if (s.size > MAX_TEXT_FILE_BYTES) {
    throw new ToolError('E2BIG', `file exceeds size limit (${s.size} bytes)`)
  }
  const bytes = await readFile(path)
  if (isProbablyBinary(bytes)) throw new ToolError('EBINARY', `file appears to be binary: ${path}`)
  const text = new TextDecoder('utf-8').decode(bytes)
  const { bom, text: body } = splitBom(text)
  return { bytes, text, body, bom, lineEnding: detectLineEnding(body) }
}

export function serializeTextFile(bodyLf: string, source: Pick<LoadedTextFile, 'bom' | 'lineEnding'>): string {
  return joinBom(restoreLineEndings(bodyLf, source.lineEnding), source.bom)
}
