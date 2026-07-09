/**
 * Tool-output overflow: cap in-history bytes, spill full content to disk.
 *
 * The kernel/executor loop wraps every tool run in `runOne`. That wrapper
 * calls `maybeOverflow` between the tool's completion and the
 * `executor:tool_result` emit. If the tool produced more than `inlineBytes`
 * of output, the full text is written to
 * `<overflowDir>/<sessionId>/<callId>.txt` and the on-wire content is
 * replaced with `previewLines` of head + a truncation marker naming the
 * spill file. See docs/tool-output-overflow.md for the design.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type OverflowConfig = {
  /** Byte threshold above which output is spilled to disk. */
  inlineBytes: number
  /** Preview head size for spilled outputs (line count). */
  previewLines: number
  /**
   * Base overflow directory. Files land at
   * `<overflowDir>/<sessionId>/<callId>.txt`.
   */
  overflowDir: string
}

export type OverflowContext = {
  sessionId: string
  callId: string
  config: OverflowConfig
}

export type OverflowResult = {
  /** What goes on the wire. Identical to input when no overflow occurred. */
  content: string
  overflowed: boolean
  /** Original UTF-8 byte length (before any truncation). Useful for telemetry. */
  fullBytes: number
  /** Full-file path when overflowed; undefined otherwise. */
  filePath?: string
}

export const DEFAULT_INLINE_BYTES = 32 * 1024
export const DEFAULT_PREVIEW_LINES = 400

export function overflowConfigFromEnv(overflowDir: string): OverflowConfig {
  const envInline = process.env.AK_OVERFLOW_INLINE_BYTES
  const envPreview = process.env.AK_OVERFLOW_PREVIEW_LINES
  const inlineBytes = envInline ? Number(envInline) : DEFAULT_INLINE_BYTES
  const previewLines = envPreview ? Number(envPreview) : DEFAULT_PREVIEW_LINES
  return {
    inlineBytes: Number.isFinite(inlineBytes) && inlineBytes >= 0 ? inlineBytes : DEFAULT_INLINE_BYTES,
    previewLines: Number.isFinite(previewLines) && previewLines > 0 ? previewLines : DEFAULT_PREVIEW_LINES,
    overflowDir,
  }
}

/**
 * Byte length of a UTF-8 string. Matches how the kernel measures message
 * content for `contextPressureLevel`.
 */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Truncate to at most `lines` head lines. If the first line already exceeds
 * `inlineBytes`, fall back to a byte-level slice so we still emit something
 * shorter than the original.
 */
function head(full: string, lines: number, inlineBytes: number): string {
  const parts = full.split('\n')
  if (parts.length <= lines) return full
  const preview = parts.slice(0, lines).join('\n')
  // Edge: a single "line" (e.g. one huge JSON blob) is longer than inlineBytes.
  // Cut it by bytes so the preview stays smaller than the original.
  if (byteLength(preview) > inlineBytes && lines > 0) {
    return Buffer.from(full, 'utf8').subarray(0, inlineBytes).toString('utf8')
  }
  return preview
}

/**
 * Sentinel string dashboards scan for. Two-line block; the second line
 * carries the resolvable file path the LLM can pass back to `read`.
 */
export function overflowMarker(
  filePath: string,
  callId: string,
  previewLines: number,
  totalLines: number,
  previewBytes: number,
  totalBytes: number,
): string {
  return [
    `--- output truncated: ${previewLines} / ${totalLines} lines, ${previewBytes} / ${totalBytes} bytes stored at overflow://${callId}`,
    `--- use \`read { path: '${filePath}' }\` to read more`,
  ].join('\n')
}

export async function maybeOverflow(
  full: string,
  ctx: OverflowContext,
): Promise<OverflowResult> {
  const { inlineBytes, previewLines, overflowDir } = ctx.config
  const fullBytes = byteLength(full)
  if (inlineBytes === 0 || fullBytes <= inlineBytes) {
    return { content: full, overflowed: false, fullBytes }
  }

  const filePath = join(overflowDir, ctx.sessionId, `${ctx.callId}.txt`)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, full, 'utf8')

  const preview = head(full, previewLines, inlineBytes)
  const totalLines = full.split('\n').length
  const previewLineCount = preview === full ? totalLines : preview.split('\n').length
  const previewByteCount = byteLength(preview)
  const marker = overflowMarker(
    filePath,
    ctx.callId,
    previewLineCount,
    totalLines,
    previewByteCount,
    fullBytes,
  )
  return {
    content: `${preview}\n\n${marker}`,
    overflowed: true,
    fullBytes,
    filePath,
  }
}
