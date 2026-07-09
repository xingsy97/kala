import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  createArtifactStore,
  PolicyTokenCaptureSchema,
  type ArtifactRef,
  type PolicyTokenCapture,
} from '@agent-kernel/shared/enhancement'

export type TokenCaptureValidation = {
  schemaVersion: 'agent.policy_token_capture_validation.v1'
  status: 'ready' | 'blocked'
  captureId?: string
  rolloutId?: string
  promptTokenCount: number
  outputTokenCount: number
  trainableTokenCount: number
  logprobCount?: number
  blockedReason?: string
}

export async function writeTokenCaptureArtifact(input: {
  rootDir: string
  capture: Omit<PolicyTokenCapture, 'schemaVersion' | 'captureId' | 'tokenizer'> & {
    captureId?: string
    tokenizer: PolicyTokenCapture['tokenizer'] | { nameOrPath: string; chatTemplate?: string }
  }
  requireLogprobs?: boolean
}): Promise<{ artifact: ArtifactRef; capture: PolicyTokenCapture; validation: TokenCaptureValidation }> {
  await mkdir(input.rootDir, { recursive: true })
  const tokenizer = 'chatTemplateHash' in input.capture.tokenizer
    ? input.capture.tokenizer
    : {
        nameOrPath: input.capture.tokenizer.nameOrPath,
        chatTemplateHash: hashText(input.capture.tokenizer.chatTemplate ?? ''),
      }
  const capture: PolicyTokenCapture = {
    ...input.capture,
    schemaVersion: 'agent.policy_token_capture.v1',
    captureId: input.capture.captureId ?? `capture_${randomUUID()}`,
    tokenizer,
  }
  const validation = validateTokenCapture(capture, { requireLogprobs: input.requireLogprobs })
  if (validation.status === 'blocked') throw new Error(validation.blockedReason ?? 'invalid token capture')
  const store = createArtifactStore(input.rootDir)
  const artifact = await store.writeJson('rl_token_capture', `rl-token-captures/${sanitize(capture.rolloutId)}/${sanitize(capture.captureId)}.json`, capture)
  return { artifact, capture, validation }
}

export async function loadTokenCapture(path: string): Promise<PolicyTokenCapture> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  const parsed = PolicyTokenCaptureSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`invalid token capture ${basename(path)}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  return parsed.data
}

export function validateTokenCapture(capture: unknown, options: { requireLogprobs?: boolean } = {}): TokenCaptureValidation {
  const parsed = PolicyTokenCaptureSchema.safeParse(capture)
  if (!parsed.success) {
    return blocked(0, 0, `schema invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const value = parsed.data
  if (value.promptIds.length === 0) return blocked(0, value.outputIds.length, 'promptIds must be non-empty')
  if (value.outputIds.length === 0) return blocked(value.promptIds.length, 0, 'outputIds must be non-empty')
  if (value.responseMask.length !== value.outputIds.length) {
    return blocked(value.promptIds.length, value.outputIds.length, `responseMask length ${value.responseMask.length} does not match outputIds length ${value.outputIds.length}`)
  }
  if (options.requireLogprobs && (!value.outputLogProbs || value.outputLogProbs.length !== value.outputIds.length)) {
    return blocked(value.promptIds.length, value.outputIds.length, 'outputLogProbs are required and must align with outputIds')
  }
  if (value.outputLogProbs && value.outputLogProbs.length !== value.outputIds.length) {
    return blocked(value.promptIds.length, value.outputIds.length, `outputLogProbs length ${value.outputLogProbs.length} does not match outputIds length ${value.outputIds.length}`)
  }
  const trainableTokenCount = value.responseMask.filter((item) => item === 1).length
  if (trainableTokenCount === 0) return blocked(value.promptIds.length, value.outputIds.length, 'responseMask has no trainable tokens')
  return {
    schemaVersion: 'agent.policy_token_capture_validation.v1',
    status: 'ready',
    captureId: value.captureId,
    rolloutId: value.rolloutId,
    promptTokenCount: value.promptIds.length,
    outputTokenCount: value.outputIds.length,
    trainableTokenCount,
    ...(value.outputLogProbs ? { logprobCount: value.outputLogProbs.length } : {}),
  }
}

function blocked(promptTokenCount: number, outputTokenCount: number, blockedReason: string): TokenCaptureValidation {
  return {
    schemaVersion: 'agent.policy_token_capture_validation.v1',
    status: 'blocked',
    promptTokenCount,
    outputTokenCount,
    trainableTokenCount: 0,
    blockedReason,
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._:-]+/g, '_')
  return cleaned.length > 0 ? cleaned : 'unknown'
}
