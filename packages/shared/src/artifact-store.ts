/**
 * Artifact store: writes redacted JSON/text payloads to disk and returns
 * SHA-hashed references. Every persisted artifact goes through
 * `redactForPersistence` so we don't leak secrets or workspace paths.
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { redactForPersistence, type RedactionOptions, type RedactionSummary } from './redaction.js'

export type ArtifactKind =
  | 'llm_request'
  | 'llm_response'
  | 'message_assembly'
  | 'router_decision'
  | 'tool_catalog'
  | 'compaction_summary_validation'
  | 'memory_retrieval'
  | 'trace'
  | 'eval_score'
  | 'eval_judge'
  | 'diff'
  | 'log'
  | 'rl_token_segments'
  | 'rl_reward'
  | 'subagent_policy'
  | 'metadata'

export type ArtifactRef = {
  kind: ArtifactKind
  uri: string
  sha256: string
  bytes: number
  redaction: RedactionSummary
  mediaType: string
}

export type ArtifactStore = {
  rootDir: string
  writeJson(kind: ArtifactKind, relativePath: string, value: unknown): Promise<ArtifactRef>
  writeText(kind: ArtifactKind, relativePath: string, value: string): Promise<ArtifactRef>
}

export function createArtifactStore(
  rootDir: string,
  options: RedactionOptions = {},
): ArtifactStore {
  return {
    rootDir,
    async writeJson(kind, relativePath, value) {
      const redacted = redactForPersistence(value, options)
      const payload = `${JSON.stringify(redacted.value, null, 2)}\n`
      return await writeArtifact(rootDir, kind, relativePath, payload, 'application/json', redacted.summary)
    },
    async writeText(kind, relativePath, value) {
      const redacted = redactForPersistence(value, options)
      const payload = `${String(redacted.value)}\n`
      return await writeArtifact(rootDir, kind, relativePath, payload, 'text/plain', redacted.summary)
    },
  }
}

async function writeArtifact(
  rootDir: string,
  kind: ArtifactKind,
  relativePath: string,
  payload: string,
  mediaType: string,
  redaction: RedactionSummary,
): Promise<ArtifactRef> {
  const target = join(rootDir, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, payload, 'utf8')
  return {
    kind,
    uri: relativePath,
    sha256: createHash('sha256').update(payload).digest('hex'),
    bytes: Buffer.byteLength(payload, 'utf8'),
    redaction,
    mediaType,
  }
}
