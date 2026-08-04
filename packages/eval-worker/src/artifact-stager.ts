import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

import { AnalyzerInputSchema, ArtifactManifestSchema, NormalizedFailureSchema, TrialEvidenceSchema, TrialTraceSchema, canonicalJson, sha256Hex, type AnalyzerInput, type ArtifactEntry, type NormalizedFailure, type TrialEvidence, type TrialTrace } from '@agent-kernel/eval-protocol'
import type { AgentRunArtifacts, ReferencedHashSigner, SandboxSnapshot, StagedTrialEvidence, VerificationArtifacts } from '@agent-kernel/eval-sdk'
import { redactJsonLine, redactText, sanitizeDiagnostic } from './redaction.js'

export class ArtifactStager {
  constructor(readonly root: string, private readonly signer: ReferencedHashSigner) {}

  async stage(input: {
    runId: string
    trialId: string
    leaseId: string
    agentArtifacts: AgentRunArtifacts
    verification: VerificationArtifacts
    analyzerInput: AnalyzerInput
    trace: TrialTrace
    workspaceBefore: SandboxSnapshot
    workspaceAfter: SandboxSnapshot
    evidence: Omit<TrialEvidence, 'artifactManifest' | 'resultHash'>
    secrets?: readonly string[]
    importedArtifacts?: { root: string; paths: readonly string[]; allowlist: readonly string[] }
  }): Promise<StagedTrialEvidence> {
    const directory = resolve(this.root, input.runId, input.trialId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const files: Array<{ name: string; mediaType: string; body: string; classification: ArtifactEntry['classification'] }> = [
      { name: 'native-events.jsonl', mediaType: 'application/x-ndjson', body: input.agentArtifacts.nativeEvents.map((event) => redactJsonLine(event, input.secrets ?? [])).join('\n') + '\n', classification: 'sensitive' },
      { name: 'normalized-events.jsonl', mediaType: 'application/x-ndjson', body: input.agentArtifacts.normalizedEvents.map((event) => redactJsonLine(event, input.secrets ?? [])).join('\n') + '\n', classification: 'operator' },
      { name: 'trace.jsonl', mediaType: 'application/x-ndjson', body: TrialTraceSchema.parse(input.trace).spans.map((span) => redactJsonLine(span, input.secrets ?? [])).join('\n') + '\n', classification: 'operator' },
      { name: 'stdout.log', mediaType: 'text/plain', body: redactText(input.agentArtifacts.stdout, input.secrets), classification: 'sensitive' },
      { name: 'stderr.log', mediaType: 'text/plain', body: redactText(input.agentArtifacts.stderr, input.secrets), classification: 'sensitive' },
      { name: 'final.diff', mediaType: 'text/x-diff', body: redactText(input.agentArtifacts.finalDiff, input.secrets), classification: 'sensitive' },
      { name: 'usage.json', mediaType: 'application/json', body: JSON.stringify(input.agentArtifacts.usage, null, 2) + '\n', classification: 'operator' },
      { name: 'verifier-result.json', mediaType: 'application/json', body: JSON.stringify(input.verification.result, null, 2) + '\n', classification: 'operator' },
      { name: 'analyzer-input.json', mediaType: 'application/json', body: JSON.stringify(AnalyzerInputSchema.parse(input.analyzerInput), null, 2) + '\n', classification: 'operator' },
      { name: 'workspace.before.json', mediaType: 'application/json', body: JSON.stringify(input.workspaceBefore, null, 2) + '\n', classification: 'operator' },
      { name: 'workspace.after.json', mediaType: 'application/json', body: JSON.stringify(input.workspaceAfter, null, 2) + '\n', classification: 'operator' },
    ]
    const entries: ArtifactEntry[] = []
    for (const file of files) {
      const path = join(directory, file.name)
      await writeFile(path, file.body, { encoding: 'utf8', mode: 0o600 })
      entries.push({ artifactId: file.name.replace(/[^A-Za-z0-9._:-]/gu, '-'), path: relative(this.root, path), mediaType: file.mediaType, bytes: Buffer.byteLength(file.body), sha256: createHash('sha256').update(file.body).digest('hex'), redaction: 'passed', classification: file.classification })
    }
    if (input.importedArtifacts) {
      entries.push(...await importArtifacts({
        sourceRoot: input.importedArtifacts.root,
        destinationRoot: directory,
        manifestRoot: this.root,
        requestedPaths: input.importedArtifacts.paths,
        allowlist: input.importedArtifacts.allowlist,
        reservedNames: files.map((file) => file.name).concat(['artifact-manifest.json', 'result.json']),
        secrets: input.secrets ?? [],
      }))
    }
    const unsigned = { schemaVersion: 1 as const, runId: input.runId, trialId: input.trialId, leaseId: input.leaseId, generatedAt: input.agentArtifacts.completedAt, entries }
    const artifactManifestHash = await sha256Hex(canonicalJson(unsigned))
    const artifactManifest = ArtifactManifestSchema.parse({ ...unsigned, manifestHash: artifactManifestHash, signature: await this.signer.signSha256(artifactManifestHash) })
    assertEvidenceReferences(input.evidence, entries)
    const evidenceWithoutHash = { ...input.evidence, artifactManifest }
    const resultHash = await sha256Hex(canonicalJson(evidenceWithoutHash))
    await writeFile(join(directory, 'artifact-manifest.json'), JSON.stringify(artifactManifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    const result = TrialEvidenceSchema.parse({ ...evidenceWithoutHash, resultHash, signature: await this.signer.signSha256(resultHash) })
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    return { artifactManifest, evidence: result, resultHash, artifactManifestHash, root: directory }
  }

  async verify(staged: StagedTrialEvidence): Promise<void> {
    for (const entry of staged.artifactManifest.entries) {
      const path = resolve(this.root, entry.path)
      if (!path.startsWith(resolve(this.root) + '/')) throw new Error('artifact path escaped root')
      const content = await readFile(path)
      const actual = createHash('sha256').update(content).digest('hex')
      if (actual !== entry.sha256) throw new Error('artifact integrity mismatch: ' + entry.path)
    }
  }

  async stageFailure(input: {
    runId: string
    trialId: string
    leaseId: string
    at: string
    state: 'blocked' | 'timeout' | 'cancelled' | 'agent_error' | 'environment_error' | 'verifier_error' | 'indeterminate'
    code: string
    message: string
    failure: NormalizedFailure
    secrets?: readonly string[]
  }): Promise<StagedTrialEvidence> {
    const directory = resolve(this.root, input.runId, input.trialId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const safeMessage = sanitizeDiagnostic(input.message, input.secrets)
    const failure = NormalizedFailureSchema.parse({ ...input.failure, summary: sanitizeDiagnostic(input.failure.summary, input.secrets), evidenceRefs: input.failure.evidenceRefs })
    const body = JSON.stringify({ schemaVersion: 1, state: input.state, code: input.code, message: safeMessage, failure, at: input.at }, null, 2) + '\n'
    const path = join(directory, 'failure.json')
    await writeFile(path, body, { encoding: 'utf8', mode: 0o600 })
    const entry: ArtifactEntry = { artifactId: 'failure.json', path: relative(this.root, path), mediaType: 'application/json', bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), redaction: 'passed', classification: 'operator' }
    const unsigned = { schemaVersion: 1 as const, runId: input.runId, trialId: input.trialId, leaseId: input.leaseId, generatedAt: input.at, entries: [entry] }
    const artifactManifestHash = await sha256Hex(canonicalJson(unsigned))
    const artifactManifest = ArtifactManifestSchema.parse({ ...unsigned, manifestHash: artifactManifestHash, signature: await this.signer.signSha256(artifactManifestHash) })
    const resultHash = await sha256Hex(canonicalJson({ state: input.state, code: input.code, message: safeMessage, artifactManifestHash }))
    await writeFile(join(directory, 'artifact-manifest.json'), JSON.stringify(artifactManifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    return { artifactManifest, resultHash, artifactManifestHash, root: directory }
  }
}

function assertEvidenceReferences(evidence: Omit<TrialEvidence, 'artifactManifest' | 'resultHash'>, entries: readonly ArtifactEntry[]): void {
  const paths = new Set(entries.map((entry) => entry.path.replaceAll('\\', '/')))
  const references = [evidence.nativeEventsRef, evidence.normalizedEventsRef, evidence.traceRef, evidence.analyzerInputRef, evidence.finalDiffRef, evidence.stdoutRef, evidence.stderrRef, evidence.benchmarkResult.rawResultRef].filter((value): value is string => value !== undefined)
  for (const reference of references) if (!paths.has(reference.replaceAll('\\', '/'))) throw new Error('trial evidence reference is not present in artifact manifest: ' + reference)
}

const MAX_IMPORTED_ARTIFACT_BYTES = 100 * 1024 * 1024

async function importArtifacts(input: {
  sourceRoot: string
  destinationRoot: string
  manifestRoot: string
  requestedPaths: readonly string[]
  allowlist: readonly string[]
  reservedNames: readonly string[]
  secrets: readonly string[]
}): Promise<ArtifactEntry[]> {
  const sourceRoot = await realpath(resolve(input.sourceRoot))
  const allowed = new Set(input.allowlist.map(normalizedRelativePath))
  const requested = [...new Set(input.requestedPaths.map(normalizedRelativePath))]
  const entries: ArtifactEntry[] = []
  for (const requestedPath of requested) {
    if (!allowed.has(requestedPath)) throw new Error('artifact is not allowlisted: ' + requestedPath)
    if (input.reservedNames.includes(requestedPath)) throw new Error('imported artifact collides with canonical evidence: ' + requestedPath)
    const source = resolve(sourceRoot, requestedPath)
    const sourceRelative = relative(sourceRoot, source)
    if (!containedRelative(sourceRelative)) throw new Error('artifact path escaped collection root: ' + requestedPath)
    const metadata = await lstat(source)
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('artifact must be a regular non-symlink file: ' + requestedPath)
    if (metadata.size > MAX_IMPORTED_ARTIFACT_BYTES) throw new Error('artifact exceeds size limit: ' + requestedPath)
    const canonicalSource = await realpath(source)
    if (!containedRelative(relative(sourceRoot, canonicalSource))) throw new Error('artifact resolved outside collection root: ' + requestedPath)
    const sourceBody = await readFile(canonicalSource)
    const { body, redaction } = sanitizeImportedArtifact(sourceBody, input.secrets, requestedPath)
    const destination = resolve(input.destinationRoot, 'extra', requestedPath)
    if (!containedRelative(relative(input.destinationRoot, destination))) throw new Error('artifact destination escaped staging root: ' + requestedPath)
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 })
    await writeFile(destination, body, { mode: 0o600 })
    entries.push({
      artifactId: ('extra-' + basename(requestedPath) + '-' + createHash('sha256').update(requestedPath).digest('hex').slice(0, 12)).replace(/[^A-Za-z0-9._:-]/gu, '-'),
      path: relative(input.manifestRoot, destination), mediaType: 'application/octet-stream', bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'), redaction, classification: 'sensitive',
    })
  }
  return entries
}

function sanitizeImportedArtifact(body: Buffer, secrets: readonly string[], path: string): { body: Buffer; redaction: 'passed' | 'not_required' } {
  const seededSecrets = [...new Set(secrets)].filter((secret) => secret.length >= 4)
  const isText = !body.subarray(0, Math.min(body.byteLength, 8_192)).includes(0)
  if (!isText) {
    if (seededSecrets.some((secret) => body.includes(Buffer.from(secret)))) throw new Error('binary artifact contains a seeded secret and cannot be safely redacted: ' + path)
    return { body, redaction: 'not_required' }
  }
  const original = body.toString('utf8')
  const sanitized = redactText(original, seededSecrets)
  return { body: Buffer.from(sanitized), redaction: 'passed' }
}

function normalizedRelativePath(path: string): string {
  const value = normalize(path).replaceAll('\\', '/')
  if (!value || value === '.' || isAbsolute(path) || value === '..' || value.startsWith('../') || value.includes('/../')) throw new Error('artifact path must be contained and relative')
  return value.replace(/^\.\//u, '')
}

function containedRelative(path: string): boolean {
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}
