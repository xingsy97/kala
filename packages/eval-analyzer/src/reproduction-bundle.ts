import { createHash, createPrivateKey, KeyObject, sign } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { ReproductionBundleSchema, ReproductionExpectedSchema, ReproductionTaskContractSchema, canonicalJson, parseTrialTraceJsonl, verifyReproductionBundleSignature as verifyTrustedReproductionBundleSignature, type DefectFinding, type EnvironmentLock, type FreshEnvironmentEvidence, type ReproductionAttempt, type ReproductionBundle, type SigningKeyRegistry } from '@agent-kernel/eval-protocol'
import type { ReferencedHashSigner } from '@agent-kernel/eval-sdk'
import { minimizeFailure } from './minimize.js'
import { appendTraceSpans, traceJsonl } from './trace-evidence.js'

export type ReproductionUnit = { id: string; path: string; content: string }
export type ReproductionExecution = FreshEnvironmentEvidence & { environmentLock: EnvironmentLock; failureFingerprint: string; evidenceRefs: readonly string[] }
export type ReproductionHarness = {
  preservesFailure(units: readonly ReproductionUnit[]): Promise<boolean>
  reproduce(units: readonly ReproductionUnit[], attemptIndex: number): Promise<ReproductionExecution>
  expectedSuccessControl(attemptIndex: number): Promise<FreshEnvironmentEvidence & { environmentLock: EnvironmentLock; passed: boolean; evidenceRefs: readonly string[] }>
}
export type BundleSigningKey = { keyReference: string; privateKey: KeyObject | string | Buffer } | ReferencedHashSigner
export type BuiltReproductionBundle = { bundle: ReproductionBundle; files: ReadonlyMap<string, Uint8Array> }

export async function buildVerifiedReproductionBundle(input: {
  bundleId: string; finding: DefectFinding; failureFingerprint: string; environmentLock: EnvironmentLock
  task: unknown; agentConfig: unknown; toolRegistry: unknown; traceJsonl: string; finalDiff: string; verifierResult: unknown; analysis: unknown
  units: readonly ReproductionUnit[]; attempts: number; minimization?: { repetitions: number; requiredPreservations: number }; harness: ReproductionHarness; signingKey: BundleSigningKey; now?: () => Date
}): Promise<BuiltReproductionBundle> {
  if (!/^[a-f0-9]{64}$/u.test(input.failureFingerprint)) throw new Error('failure fingerprint must be SHA-256')
  if (input.attempts < 2) throw new Error('reproduction requires at least two fresh attempts')
  const task = ReproductionTaskContractSchema.parse(input.task)
  scanPrivateMaterial(input)
  const minimized = await minimizeFailure(input.units, (candidate) => input.harness.preservesFailure(candidate), input.minimization)
  const environmentLockHash = sha256(canonicalJson(input.environmentLock))
  const attemptEvidence: ReproductionAttempt[] = []
  const verificationSpans: Array<{ spanId: string; name: 'reproduction.verify'; startedAt: string; completedAt: string; status: 'ok' | 'error'; artifactRefs: string[]; outcomeCategory: string }> = []
  const now = input.now ?? (() => new Date())
  for (let index = 0; index < input.attempts; index += 1) {
    const startedAt = now().toISOString()
    const result = await input.harness.reproduce(minimized.minimized, index)
    const completedAt = now().toISOString()
    const reproduced = result.failureFingerprint === input.failureFingerprint
    attemptEvidence.push({ attemptId: 'attempt-' + String(index + 1), freshEnvironmentId: result.freshEnvironmentId, providerAttestation: result.providerAttestation, imageDigest: result.imageDigest, nonce: result.nonce, initialStateHash: result.initialStateHash, networkPolicyHash: result.networkPolicyHash, cleanupReceipt: result.cleanupReceipt, environmentLockHash: sha256(canonicalJson(result.environmentLock)), observedFailureFingerprint: result.failureFingerprint, reproduced, evidenceRefs: [...result.evidenceRefs] })
    verificationSpans.push({ spanId: 'reproduction-attempt-' + String(index + 1), name: 'reproduction.verify', startedAt, completedAt, status: reproduced ? 'ok' : 'error', artifactRefs: [...result.evidenceRefs], outcomeCategory: reproduced ? 'failure_reproduced' : 'fingerprint_mismatch' })
  }
  const controlStartedAt = now().toISOString()
  const control = await input.harness.expectedSuccessControl(input.attempts)
  const controlCompletedAt = now().toISOString()
  if (!control.passed) throw new Error('expected-success control did not pass')
  verificationSpans.push({ spanId: 'reproduction-success-control', name: 'reproduction.verify', startedAt: controlStartedAt, completedAt: controlCompletedAt, status: 'ok', artifactRefs: [...control.evidenceRefs], outcomeCategory: 'expected_success_control_passed' })
  const sourceTrace = parseTrialTraceJsonl(input.traceJsonl)
  if (!sourceTrace.spans.some((span) => span.name === 'analyzer.detect')) throw new Error('reproduction source trace requires analyzer.detect evidence')
  const reproductionTraceJsonl = traceJsonl(appendTraceSpans(input.traceJsonl, verificationSpans))
  const prefix = 'bundles/' + safeId(input.bundleId) + '/'
  const workspaceArchive = deterministicWorkspaceArchive(minimized.minimized)
  const analysis = { ...object(input.analysis), minimization: { originalUnits: minimized.originalSize, minimizedUnits: minimized.minimized.length, attempts: minimized.attempts }, reproductionAttempts: attemptEvidence }
  const payloads = new Map<string, Uint8Array>([
    [prefix + 'defect.json', json(input.finding)], [prefix + 'task.json', json(task)], [prefix + 'environment.lock.json', json(input.environmentLock)],
    [prefix + 'agent-config.json', json(input.agentConfig)], [prefix + 'tool-registry.json', json(input.toolRegistry)], [prefix + 'minimal-workspace.tar.zst', workspaceArchive],
    [prefix + 'replay.jsonl', text(minimized.minimized.map((unit) => canonicalJson(unit)).join('\n') + '\n')], [prefix + 'trace.jsonl', text(reproductionTraceJsonl)],
    [prefix + 'final.diff', text(input.finalDiff)], [prefix + 'verifier-result.json', json(input.verifierResult)], [prefix + 'analysis.json', json(analysis)],
    [prefix + 'expected.json', json(ReproductionExpectedSchema.parse({ failureFingerprint: input.failureFingerprint, attempts: input.attempts, expectedSuccessControl: true }))],
    [prefix + 'reproduce.sh', text('#!/bin/sh\nset -eu\nexec agent-eval reproduce --bundle "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\n')],
  ])
  for (const [path, content] of payloads) scanPrivateMaterial(new TextDecoder().decode(content), path.endsWith('.tar.zst'))
  const checksumLines = [...payloads].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => sha256(content) + '  ' + path.slice(prefix.length)).join('\n') + '\n'
  payloads.set(prefix + 'SHA256SUMS', text(checksumLines))
  const files = [...payloads].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({ path, sha256: sha256(content), bytes: content.byteLength, mediaType: mediaType(path) }))
  const unsigned = { schemaVersion: 1 as const, bundleId: input.bundleId, findingId: input.finding.findingId, failureFingerprint: input.failureFingerprint, environmentLockHash, files, reproduction: { attempts: attemptEvidence, reproduced: attemptEvidence.filter((attempt) => attempt.reproduced).length, expectedSuccessControl: { freshEnvironmentId: control.freshEnvironmentId, providerAttestation: control.providerAttestation, imageDigest: control.imageDigest, nonce: control.nonce, initialStateHash: control.initialStateHash, networkPolicyHash: control.networkPolicyHash, cleanupReceipt: control.cleanupReceipt, environmentLockHash: sha256(canonicalJson(control.environmentLock)), passed: true as const, evidenceRefs: [...control.evidenceRefs] }, minimization: { originalUnits: minimized.originalSize, minimizedUnits: minimized.minimized.length, attempts: minimized.attempts, repetitions: minimized.repetitions, requiredPreservations: minimized.requiredPreservations, oneMinimalVerified: minimized.oneMinimalVerified } }, privacy: { redactionPassed: true as const, secretScanPassed: true as const, absolutePathScanPassed: true as const } }
  if (unsigned.reproduction.reproduced < 2) throw new Error('failure was not reproduced in at least two fresh environments')
  const signedPayloadHash = sha256(canonicalJson(unsigned))
  const signature = 'signSha256' in input.signingKey
    ? await input.signingKey.signSha256(signedPayloadHash)
    : legacySignature(input.signingKey, signedPayloadHash)
  const bundle = ReproductionBundleSchema.parse({ ...unsigned, signedPayloadHash, signature })
  return { bundle, files: payloads }
}
function legacySignature(signingKey: Exclude<BundleSigningKey, ReferencedHashSigner>, hash: string) {
  const privateKey = signingKey.privateKey instanceof KeyObject ? signingKey.privateKey : createPrivateKey(signingKey.privateKey)
  return { algorithm: 'ed25519' as const, keyReference: signingKey.keyReference, valueBase64: sign(null, Buffer.from(hash, 'hex'), privateKey).toString('base64') }
}

export async function verifyReproductionBundleSignature(bundle: ReproductionBundle, registry: SigningKeyRegistry, verificationTime?: string | Date): Promise<boolean> {
  try { await verifyTrustedReproductionBundleSignature(bundle, registry, verificationTime); return true } catch { return false }
}

function deterministicWorkspaceArchive(units: readonly ReproductionUnit[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const paths = new Set<string>()
  for (const unit of [...units].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!unit.path || unit.path.startsWith('/') || unit.path === '..' || unit.path.startsWith('../') || unit.path.includes('/../') || unit.path.includes('\0')) throw new Error('reproduction unit path must be relative and contained')
    if (paths.has(unit.path)) throw new Error('reproduction unit paths must be unique')
    paths.add(unit.path)
    const name = text(unit.path)
    if (name.byteLength > 100) throw new Error('reproduction unit path exceeds deterministic ustar name limit')
    const body = text(unit.content)
    const header = new Uint8Array(512)
    header.set(name, 0)
    octal(header, 100, 8, 0o644)
    octal(header, 108, 8, 0)
    octal(header, 116, 8, 0)
    octal(header, 124, 12, body.byteLength)
    octal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = 0x30
    header.set(text('ustar\0'), 257)
    header.set(text('00'), 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    const encodedChecksum = checksum.toString(8).padStart(6, '0')
    header.set(text(encodedChecksum), 148); header[154] = 0; header[155] = 0x20
    chunks.push(header, body)
    const padding = (512 - body.byteLength % 512) % 512
    if (padding) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(1024))
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const tar = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { tar.set(chunk, offset); offset += chunk.byteLength }
  return zstdCompressSync(tar)
}
function octal(target: Uint8Array, offset: number, width: number, value: number): void {
  const encoded = value.toString(8).padStart(width - 1, '0') + '\0'
  target.set(text(encoded), offset)
}
function scanPrivateMaterial(value: unknown, binary = false): void { if (binary) return; visit(value, (candidate) => { if (/(?:^|[\s'"])(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root)(?:\/|$)/u.test(candidate) || /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/u.test(candidate)) throw new Error('reproduction bundle contains a private absolute path'); if (/(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~-]{16,})/u.test(candidate)) throw new Error('reproduction bundle contains a likely secret') }) }
function visit(value: unknown, consume: (value: string) => void): void { if (typeof value === 'string') consume(value); else if (Array.isArray(value)) for (const item of value) visit(item, consume); else if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) visit(item, consume) }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value } }
function text(value: string): Uint8Array { return new TextEncoder().encode(value) }
function json(value: unknown): Uint8Array { return text(JSON.stringify(value, null, 2) + '\n') }
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 120) }
function mediaType(path: string): string { if (path.endsWith('.json')) return 'application/json'; if (path.endsWith('.jsonl')) return 'application/x-ndjson'; if (path.endsWith('.diff')) return 'text/x-diff'; if (path.endsWith('.sh')) return 'text/x-shellscript'; if (path.endsWith('.zst')) return 'application/zstd'; return 'text/plain' }
