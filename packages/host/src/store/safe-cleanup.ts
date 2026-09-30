import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

export const SAFE_CLEANUP_OPERATIONS = [
  'subagent-details',
  'session-tree',
  'orphan-artifacts',
  'derived-artifacts',
] as const

export type SafeCleanupOperation = typeof SAFE_CLEANUP_OPERATIONS[number]
export type SafeCleanupEntryType = 'file' | 'directory'

export type SafeCleanupManifestEntry = {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly type: SafeCleanupEntryType
}

export type SafeCleanupPlan = {
  readonly planId: string
  readonly preparedAt: string
  readonly expiresAt: string
  readonly operation: SafeCleanupOperation
  readonly targetId: string
  readonly sessionIds: readonly string[]
  readonly manifest: readonly SafeCleanupManifestEntry[]
  readonly topLevelPaths: readonly string[]
  readonly estimatedBytes: number
  readonly generation: string
  readonly fingerprint: string
}

export type SafeCleanupResult = {
  readonly planId: string
  readonly operation: SafeCleanupOperation
  readonly targetId: string
  readonly logicalDeletion: true
  readonly bytesQuarantined: number
  readonly quarantinePath: string
  readonly completedAt: string
}

export type SafeCleanupRecoveryResult = {
  readonly planId: string
  readonly status: 'completed' | 'failed'
  readonly result?: SafeCleanupResult
  readonly error?: string
}

export type SafeCleanupOptions = {
  readonly sessionsDir: string
  readonly quarantineDir: string
  readonly metadataDir: string
  readonly planTtlMs?: number
  readonly now?: () => Date
  readonly withMutationLease?: <T>(
    sessionIds: readonly string[],
    action: () => Promise<T>,
  ) => Promise<T>
  readonly onSessionsQuarantined?: (sessionIds: readonly string[]) => void | Promise<void>
}

type ActiveSessionSource =
  | ReadonlySet<string>
  | readonly string[]
  | (() => ReadonlySet<string> | readonly string[])

type SessionHeader = {
  sessionId: string
  parentSessionId?: string
  slug: string
  logPath: string
}

type JournalMove = {
  sourcePath: string
  quarantineName: string
  state: 'pending' | 'moved'
}

type CleanupJournal = {
  schemaVersion: 1
  plan: SafeCleanupPlan
  state: 'moving' | 'completed' | 'failed'
  quarantinePath: string
  moves: JournalMove[]
  createdAt: string
  updatedAt: string
  result?: SafeCleanupResult
  error?: string
}

const HEADER_LIMIT = 1024 * 1024

export class SafeCleanupError extends Error {
  constructor(
    readonly code:
      | 'active-session'
      | 'corrupt-header'
      | 'expired-plan'
      | 'invalid-target'
      | 'manifest-changed'
      | 'missing-target'
      | 'path-escape'
      | 'quarantine-device'
      | 'recovery-failed'
      | 'root-session'
      | 'symlink'
      | 'unsupported-file',
    message: string,
  ) {
    super(message)
    this.name = 'SafeCleanupError'
  }
}

export class SafeCleanupEngine {
  private readonly sessionsDir: string
  private readonly quarantineDir: string
  private readonly metadataDir: string
  private readonly planTtlMs: number
  private readonly now: () => Date
  private readonly withMutationLease: NonNullable<SafeCleanupOptions['withMutationLease']>
  private readonly onSessionsQuarantined?: SafeCleanupOptions['onSessionsQuarantined']
  private readonly plans = new Map<string, SafeCleanupPlan>()
  private readonly completed = new Map<string, SafeCleanupResult>()

  constructor(options: SafeCleanupOptions) {
    this.sessionsDir = resolve(options.sessionsDir)
    this.quarantineDir = resolve(options.quarantineDir)
    this.metadataDir = resolve(options.metadataDir)
    this.planTtlMs = options.planTtlMs ?? 5 * 60_000
    this.now = options.now ?? (() => new Date())
    this.withMutationLease = options.withMutationLease
      ?? (async <T>(_sessionIds: readonly string[], action: () => Promise<T>): Promise<T> => await action())
    this.onSessionsQuarantined = options.onSessionsQuarantined
    if (pathsOverlap(this.sessionsDir, this.quarantineDir)) {
      throw new SafeCleanupError('invalid-target', 'sessionsDir and quarantineDir must not overlap')
    }
    if (pathsOverlap(this.sessionsDir, this.metadataDir) || pathsOverlap(this.quarantineDir, this.metadataDir)) {
      throw new SafeCleanupError('invalid-target', 'metadataDir must not overlap cleanup data roots')
    }
  }

  async prepare(
    operation: SafeCleanupOperation,
    targetId: string,
    activeSessionIds: ReadonlySet<string> | readonly string[],
  ): Promise<SafeCleanupPlan> {
    this.assertOperation(operation)
    assertTargetId(targetId)
    await this.ensureRoots()
    await this.assertSameDevice()

    const active = new Set(activeSessionIds)
    const headers = operation === 'orphan-artifacts' ? [] : await this.readSessionHeaders()
    const resolved = await this.resolveTargets(operation, targetId, headers)
    for (const sessionId of resolved.sessionIds) {
      if (active.has(sessionId)) {
        throw new SafeCleanupError('active-session', `session ${sessionId} is active`)
      }
    }

    const topLevelPaths = unique(resolved.paths)
    if (topLevelPaths.length === 0) {
      throw new SafeCleanupError('missing-target', `no cleanup targets found for ${targetId}`)
    }
    const manifest = await this.buildManifest(topLevelPaths)
    const estimatedBytes = manifest.reduce(
      (total, entry) => total + (entry.type === 'file' ? entry.size : 0),
      0,
    )
    const preparedAt = this.now()
    const identity = {
      operation,
      targetId,
      sessionIds: [...resolved.sessionIds],
      manifest,
      topLevelPaths,
      estimatedBytes,
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    const plan: SafeCleanupPlan = deepFreeze({
      planId: randomUUID(),
      preparedAt: preparedAt.toISOString(),
      expiresAt: new Date(preparedAt.getTime() + this.planTtlMs).toISOString(),
      operation,
      targetId,
      sessionIds: identity.sessionIds,
      manifest,
      topLevelPaths,
      estimatedBytes,
      generation: fingerprint,
      fingerprint,
    })
    this.plans.set(plan.planId, plan)
    return plan
  }

  async execute(
    planId: string,
    activeSessionIds: ActiveSessionSource,
  ): Promise<SafeCleanupResult> {
    const existing = this.completed.get(planId) ?? await this.readCompletedResult(planId)
    if (existing) {
      this.completed.set(planId, existing)
      return existing
    }
    const plan = this.plans.get(planId)
    if (!plan) throw new SafeCleanupError('invalid-target', `unknown cleanup plan ${planId}`)
    return await this.withMutationLease(plan.sessionIds, async () => {
      if (this.now().getTime() > Date.parse(plan.expiresAt)) {
        throw new SafeCleanupError('expired-plan', `cleanup plan ${planId} expired`)
      }
      await this.assertSameDevice()
      this.assertInactive(plan, resolveActiveSessions(activeSessionIds))
      await this.revalidate(plan)

      const quarantinePath = join(this.quarantineDir, plan.planId)
      const moves = plan.topLevelPaths.map((sourcePath, index) => ({
        sourcePath,
        quarantineName: `${String(index).padStart(4, '0')}-${basename(sourcePath)}`,
        state: 'pending' as const,
      }))
      let journal: CleanupJournal = {
        schemaVersion: 1,
        plan,
        state: 'moving',
        quarantinePath,
        moves,
        createdAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      }
      await this.writeJournal(journal)
      if (removesSessionDetails(plan.operation)) await this.writeTombstone(plan)
      await this.ensureQuarantinePath(quarantinePath)
      this.assertInactive(plan, resolveActiveSessions(activeSessionIds))
      await this.revalidate(plan)

      for (let index = 0; index < journal.moves.length; index += 1) {
        const move = journal.moves[index]!
        await this.revalidateTopLevel(plan, move.sourcePath)
        await rename(move.sourcePath, join(quarantinePath, move.quarantineName))
        await syncDirectory(dirname(move.sourcePath))
        await syncDirectory(quarantinePath)
        journal = {
          ...journal,
          updatedAt: this.now().toISOString(),
          moves: journal.moves.map((candidate, candidateIndex) => (
            candidateIndex === index ? { ...candidate, state: 'moved' } : candidate
          )),
        }
        await this.writeJournal(journal)
      }

      const result = this.resultFor(plan, quarantinePath)
      journal = { ...journal, state: 'completed', result, updatedAt: result.completedAt }
      await this.writeJournal(journal)
      await this.writeAudit(plan, result)
      if (removesSessionDetails(plan.operation)) {
        await this.onSessionsQuarantined?.(plan.sessionIds)
      }
      this.completed.set(planId, result)
      return result
    })
  }

  async recover(
    activeSessionIds: ActiveSessionSource = [],
  ): Promise<readonly SafeCleanupRecoveryResult[]> {
    await this.ensureRoots()
    await this.assertSameDevice()
    const journalDir = this.journalDir()
    const names = (await readdir(journalDir)).filter((name) => name.endsWith('.json')).sort()
    const results: SafeCleanupRecoveryResult[] = []
    for (const name of names) {
      let journal: CleanupJournal
      try {
        journal = parseJournal(JSON.parse(await readFile(join(journalDir, name), 'utf8')))
        if (journal.state === 'completed' && journal.result) {
          await this.writeAudit(journal.plan, journal.result)
          this.completed.set(journal.plan.planId, journal.result)
          results.push({ planId: journal.plan.planId, status: 'completed', result: journal.result })
          continue
        }
        if (journal.state === 'failed') {
          results.push({
            planId: journal.plan.planId,
            status: 'failed',
            error: journal.error ?? 'cleanup journal is in failed state',
          })
          continue
        }
        this.assertRecoveryPaths(journal)
        journal = await this.withMutationLease(journal.plan.sessionIds, async () => {
          this.assertInactive(journal.plan, resolveActiveSessions(activeSessionIds))
          const completed = await this.completeJournal(journal)
          if (removesSessionDetails(journal.plan.operation)) {
            await this.onSessionsQuarantined?.(journal.plan.sessionIds)
          }
          return completed
        })
        const result = journal.result!
        this.completed.set(journal.plan.planId, result)
        results.push({ planId: journal.plan.planId, status: 'completed', result })
      } catch (error) {
        const planId = journalPlanId(error, name)
        const message = error instanceof Error ? error.message : String(error)
        results.push({ planId, status: 'failed', error: message })
      }
    }
    return results
  }

  async listTombstonedSessionIds(): Promise<readonly string[]> {
    await this.ensureRoots()
    const ids = new Set<string>()
    for (const name of (await readdir(join(this.metadataDir, 'tombstones'))).filter((entry) => entry.endsWith('.json'))) {
      const value: unknown = JSON.parse(await readFile(join(this.metadataDir, 'tombstones', name), 'utf8'))
      if (!isRecord(value)) throw new SafeCleanupError('corrupt-header', `invalid cleanup tombstone ${name}`)
      if (typeof value.sessionId === 'string' && value.sessionId) ids.add(value.sessionId)
      if (Array.isArray(value.descendantSessionIds)) {
        for (const sessionId of value.descendantSessionIds) {
          if (typeof sessionId === 'string' && sessionId) ids.add(sessionId)
        }
      }
    }
    return [...ids].sort()
  }

  private async resolveTargets(
    operation: SafeCleanupOperation,
    targetId: string,
    headers: readonly SessionHeader[],
  ): Promise<{ sessionIds: string[]; paths: string[] }> {
    if (operation === 'orphan-artifacts') {
      const artifactPath = this.internalPath(join('artifacts', targetId))
      if (!await this.internalExists(artifactPath)) {
        throw new SafeCleanupError('missing-target', `artifact target does not exist: ${artifactPath}`)
      }
      await requireDirectory(artifactPath)
      await this.assertOrphanArtifactUnowned(targetId)
      return { sessionIds: [], paths: [artifactPath] }
    }

    const target = headers.find((header) => header.sessionId === targetId)
    if (!target) throw new SafeCleanupError('missing-target', `session ${targetId} was not found`)
    if (operation === 'subagent-details' && !target.parentSessionId) {
      throw new SafeCleanupError('root-session', 'subagent-details requires a session with parentSessionId')
    }
    const selected = descendantsOf(targetId, headers)
    const paths: string[] = []
    for (const header of selected) {
      if (operation !== 'derived-artifacts') {
        paths.push(header.logPath)
        for (const sidecar of [
          `${header.slug}.snapshot.json`,
          `${header.slug}.jsonl.summary.json`,
          `${header.slug}.jsonl.context.json`,
        ]) {
          const path = this.internalPath(sidecar)
          if (await this.internalExists(path)) paths.push(path)
        }
      }
      const artifactPath = this.internalPath(join('artifacts', header.slug))
      if (await this.internalExists(artifactPath)) paths.push(artifactPath)
    }
    return {
      sessionIds: selected.map((header) => header.sessionId),
      paths: orderLeafFirst(paths, selected),
    }
  }

  private async readSessionHeaders(): Promise<SessionHeader[]> {
    const headers: SessionHeader[] = []
    const sessionIds = new Set<string>()
    for (const name of (await readdir(this.sessionsDir)).sort()) {
      if (!name.endsWith('.jsonl')) continue
      const logPath = this.internalPath(name)
      const file = await lstat(logPath)
      assertSupported(file, logPath)
      if (!file.isFile()) throw new SafeCleanupError('unsupported-file', `${logPath} is not a regular file`)
      const parsed = await readHeader(logPath)
      if (sessionIds.has(parsed.sessionId)) {
        throw new SafeCleanupError('corrupt-header', `duplicate session id ${parsed.sessionId}`)
      }
      sessionIds.add(parsed.sessionId)
      headers.push({
        ...parsed,
        slug: name.slice(0, -'.jsonl'.length),
        logPath,
      })
    }
    return headers
  }

  private async buildManifest(
    topLevelPaths: readonly string[],
    root: string = this.sessionsDir,
  ): Promise<SafeCleanupManifestEntry[]> {
    const entries: SafeCleanupManifestEntry[] = []
    for (const topLevelPath of topLevelPaths) {
      await this.assertNoSymlinkComponents(topLevelPath, root)
      const pending = [topLevelPath]
      while (pending.length > 0) {
        const path = pending.pop()!
        const file = await lstat(path)
        assertSupported(file, path)
        entries.push(toManifestEntry(root, path, file))
        if (!file.isDirectory()) continue
        const names = (await readdir(path)).sort().reverse()
        for (const name of names) pending.push(resolveInternalPath(root, join(relative(root, path), name)))
      }
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path))
  }

  private async revalidate(plan: SafeCleanupPlan): Promise<void> {
    if (plan.operation === 'orphan-artifacts') {
      await this.assertOrphanArtifactUnowned(plan.targetId)
    }
    if (removesSessionDetails(plan.operation)) {
      const headers = await this.readSessionHeaders()
      const currentSessionIds = descendantsOf(plan.targetId, headers)
        .map((header) => header.sessionId)
        .sort()
      if (JSON.stringify(currentSessionIds) !== JSON.stringify([...plan.sessionIds].sort())) {
        throw new SafeCleanupError('manifest-changed', `cleanup plan ${plan.planId} session tree changed`)
      }
    }
    const current = await this.buildManifest(plan.topLevelPaths)
    if (JSON.stringify(current) !== JSON.stringify(plan.manifest)) {
      throw new SafeCleanupError('manifest-changed', `cleanup plan ${plan.planId} manifest changed`)
    }

    const fingerprint = createHash('sha256').update(JSON.stringify({
      operation: plan.operation,
      targetId: plan.targetId,
      sessionIds: plan.sessionIds,
      manifest: current,
      topLevelPaths: plan.topLevelPaths,
      estimatedBytes: plan.estimatedBytes,
    })).digest('hex')
    if (fingerprint !== plan.fingerprint || plan.generation !== plan.fingerprint) {
      throw new SafeCleanupError('manifest-changed', `cleanup plan ${plan.planId} fingerprint changed`)
    }
  }

  private async assertOrphanArtifactUnowned(targetId: string): Promise<void> {
    const sessionLog = this.internalPath(`${targetId}.jsonl`)
    if (await this.internalExists(sessionLog)) {
      throw new SafeCleanupError('invalid-target', `artifact ${targetId} belongs to a session`)
    }
  }

  private async revalidateTopLevel(plan: SafeCleanupPlan, path: string): Promise<void> {
    if (plan.operation === 'orphan-artifacts') {
      await this.assertOrphanArtifactUnowned(plan.targetId)
    }
    const expected = plan.manifest.find((entry) => entry.path === relative(this.sessionsDir, path))
    if (!expected) throw new SafeCleanupError('manifest-changed', `cleanup target ${path} is absent from the manifest`)
    const current = toManifestEntry(this.sessionsDir, path, await lstat(path))
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new SafeCleanupError('manifest-changed', `cleanup target ${path} changed before quarantine`)
    }
  }

  private async completeJournal(journal: CleanupJournal): Promise<CleanupJournal> {
    if (removesSessionDetails(journal.plan.operation)) await this.writeTombstone(journal.plan)
    await this.ensureQuarantinePath(journal.quarantinePath)
    for (const move of journal.moves) {
      const destination = join(journal.quarantinePath, move.quarantineName)
      const sourceExists = await safePathExists(this.sessionsDir, move.sourcePath)
      const destinationExists = await safePathExists(this.quarantineDir, destination)
      if (sourceExists && destinationExists) {
        return this.failJournal(journal, `both source and quarantine target exist for ${move.sourcePath}`)
      }
      if (!sourceExists && !destinationExists) {
        return this.failJournal(journal, `neither source nor quarantine target exists for ${move.sourcePath}`)
      }
      try {
        if (sourceExists) await this.revalidateRemainingSource(journal.plan, move.sourcePath)
        else await this.revalidateQuarantineDestination(journal.plan, move.sourcePath, destination)
      } catch (error) {
        return this.failJournal(journal, error instanceof Error ? error.message : String(error))
      }
    }
    for (let index = 0; index < journal.moves.length; index += 1) {
      const move = journal.moves[index]!
      const destination = join(journal.quarantinePath, move.quarantineName)
      const sourceExists = await safePathExists(this.sessionsDir, move.sourcePath)
      const destinationExists = await safePathExists(this.quarantineDir, destination)
      if (sourceExists && destinationExists) {
        return this.failJournal(journal, `both source and quarantine target exist for ${move.sourcePath}`)
      }
      if (!sourceExists && !destinationExists) {
        return this.failJournal(journal, `neither source nor quarantine target exists for ${move.sourcePath}`)
      }
      if (sourceExists) {
        try {
          await this.revalidateRemainingSource(journal.plan, move.sourcePath)
        } catch (error) {
          return this.failJournal(journal, error instanceof Error ? error.message : String(error))
        }
        await rename(move.sourcePath, destination)
        await syncDirectory(dirname(move.sourcePath))
        await syncDirectory(journal.quarantinePath)
      } else {
        try {
          await this.revalidateQuarantineDestination(journal.plan, move.sourcePath, destination)
        } catch (error) {
          return this.failJournal(journal, error instanceof Error ? error.message : String(error))
        }
      }
      journal = {
        ...journal,
        updatedAt: this.now().toISOString(),
        moves: journal.moves.map((candidate, candidateIndex) => (
          candidateIndex === index ? { ...candidate, state: 'moved' } : candidate
        )),
      }
      await this.writeJournal(journal)
    }
    const result = this.resultFor(journal.plan, journal.quarantinePath)
    journal = { ...journal, state: 'completed', result, updatedAt: result.completedAt }
    await this.writeJournal(journal)
    await this.writeAudit(journal.plan, result)
    return journal
  }

  private async failJournal(journal: CleanupJournal, error: string): Promise<never> {
    const failed = { ...journal, state: 'failed' as const, error, updatedAt: this.now().toISOString() }
    await this.writeJournal(failed)
    throw new SafeCleanupError('recovery-failed', error)
  }

  private assertRecoveryPaths(journal: CleanupJournal): void {
    const expectedQuarantinePath = join(this.quarantineDir, journal.plan.planId)
    if (journal.quarantinePath !== expectedQuarantinePath) {
      throw new SafeCleanupError('recovery-failed', 'journal quarantine path is invalid')
    }
    if (
      journal.moves.length !== journal.plan.topLevelPaths.length
      || journal.moves.some((move, index) => (
        move.sourcePath !== journal.plan.topLevelPaths[index]
        || move.quarantineName !== `${String(index).padStart(4, '0')}-${basename(move.sourcePath)}`
      ))
    ) {
      throw new SafeCleanupError('recovery-failed', 'journal move manifest is invalid')
    }
    for (const path of journal.plan.topLevelPaths) {
      this.internalPath(relative(this.sessionsDir, path))
    }
  }

  private resultFor(plan: SafeCleanupPlan, quarantinePath: string): SafeCleanupResult {
    return {
      planId: plan.planId,
      operation: plan.operation,
      targetId: plan.targetId,
      logicalDeletion: true,
      bytesQuarantined: plan.estimatedBytes,
      quarantinePath,
      completedAt: this.now().toISOString(),
    }
  }

  private assertInactive(
    plan: SafeCleanupPlan,
    activeSessionIds: ReadonlySet<string> | readonly string[],
  ): void {
    const active = new Set(activeSessionIds)
    const blocked = plan.sessionIds.find((sessionId) => active.has(sessionId))
    if (blocked) throw new SafeCleanupError('active-session', `session ${blocked} is active`)
  }

  private async writeTombstone(plan: SafeCleanupPlan): Promise<void> {
    const target = plan.targetId
    const path = join(this.metadataDir, 'tombstones', `${hashName(target ?? plan.targetId)}.json`)
    await writeDurableJson(path, {
      schemaVersion: 1,
      sessionId: target,
      operation: plan.operation,
      planId: plan.planId,
      deletedAt: this.now().toISOString(),
      descendantSessionIds: plan.sessionIds.filter((sessionId) => sessionId !== target),
    })
  }

  private async revalidateRemainingSource(plan: SafeCleanupPlan, path: string): Promise<void> {
    const relativePath = relative(this.sessionsDir, path)
    const prefix = `${relativePath}${sep}`
    const expected = plan.manifest.filter((entry) => entry.path === relativePath || entry.path.startsWith(prefix))
    const current = await this.buildManifest([path])
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new SafeCleanupError('manifest-changed', `cleanup recovery source ${path} changed`)
    }
  }

  private async revalidateQuarantineDestination(
    plan: SafeCleanupPlan,
    sourcePath: string,
    destination: string,
  ): Promise<void> {
    const sourceRelative = relative(this.sessionsDir, sourcePath)
    const sourcePrefix = `${sourceRelative}${sep}`
    const expected = plan.manifest.filter((entry) => (
      entry.path === sourceRelative || entry.path.startsWith(sourcePrefix)
    ))
    const destinationRelative = relative(this.quarantineDir, destination)
    const current = (await this.buildManifest([destination], this.quarantineDir)).map((entry) => ({
      ...entry,
      path: entry.path === destinationRelative
        ? sourceRelative
        : `${sourceRelative}${entry.path.slice(destinationRelative.length)}`,
    }))
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new SafeCleanupError('manifest-changed', `cleanup quarantine target ${destination} changed`)
    }
  }

  private async writeJournal(journal: CleanupJournal): Promise<void> {
    await writeDurableJson(join(this.journalDir(), `${journal.plan.planId}.json`), journal)
  }

  private async writeAudit(plan: SafeCleanupPlan, result: SafeCleanupResult): Promise<void> {
    await writeDurableJson(join(this.metadataDir, 'audit', `${plan.planId}.json`), {
      schemaVersion: 1,
      planId: plan.planId,
      operation: plan.operation,
      targetId: plan.targetId,
      sessionIds: plan.sessionIds,
      generation: plan.generation,
      manifestEntries: plan.manifest.length,
      estimatedBytes: plan.estimatedBytes,
      bytesQuarantined: result.bytesQuarantined,
      logicalDeletion: true,
      preparedAt: plan.preparedAt,
      completedAt: result.completedAt,
    })
  }

  private async readCompletedResult(planId: string): Promise<SafeCleanupResult | undefined> {
    try {
      const journal = parseJournal(JSON.parse(await readFile(join(this.journalDir(), `${planId}.json`), 'utf8')))
      return journal.state === 'completed' ? journal.result : undefined
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  private journalDir(): string {
    return join(this.metadataDir, 'journals')
  }

  private async ensureQuarantinePath(path: string): Promise<void> {
    if (await safePathExists(this.quarantineDir, path)) {
      const file = await lstat(path)
      if (!file.isDirectory()) {
        throw new SafeCleanupError('unsupported-file', `quarantine plan path is not a directory: ${path}`)
      }
      return
    }
    await mkdir(path, { recursive: false })
    await syncDirectory(this.quarantineDir)
  }

  private async ensureRoots(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true })
    await mkdir(this.quarantineDir, { recursive: true })
    await mkdir(this.journalDir(), { recursive: true })
    await mkdir(join(this.metadataDir, 'audit'), { recursive: true })
    await mkdir(join(this.metadataDir, 'tombstones'), { recursive: true })
    for (const path of [this.sessionsDir, this.quarantineDir, this.metadataDir]) {
      const file = await lstat(path)
      if (file.isSymbolicLink()) throw new SafeCleanupError('symlink', `symlink is not allowed: ${path}`)
      if (!file.isDirectory()) throw new SafeCleanupError('unsupported-file', `cleanup root is not a directory: ${path}`)
    }
  }

  private async assertSameDevice(): Promise<void> {
    const [sessions, quarantine] = await Promise.all([stat(this.sessionsDir), stat(this.quarantineDir)])
    if (sessions.dev !== quarantine.dev) {
      throw new SafeCleanupError('quarantine-device', 'sessionsDir and quarantineDir must be on the same device')
    }
  }

  private internalPath(path: string): string {
    const resolved = resolve(this.sessionsDir, path)
    if (resolved === this.sessionsDir || !resolved.startsWith(`${this.sessionsDir}${sep}`)) {
      throw new SafeCleanupError('path-escape', `path escapes sessionsDir: ${path}`)
    }
    return resolved
  }

  private async assertNoSymlinkComponents(path: string, root: string = this.sessionsDir): Promise<void> {
    const internal = relative(root, path)
    if (!internal || internal === '..' || internal.startsWith(`..${sep}`)) {
      throw new SafeCleanupError('path-escape', `path escapes storage root: ${path}`)
    }
    let current = root
    for (const component of internal.split(sep)) {
      current = join(current, component)
      const file = await lstat(current)
      if (file.isSymbolicLink()) throw new SafeCleanupError('symlink', `symlink is not allowed: ${current}`)
    }
  }

  private async internalExists(path: string): Promise<boolean> {
    const internal = relative(this.sessionsDir, path)
    if (!internal || internal === '..' || internal.startsWith(`..${sep}`)) {
      throw new SafeCleanupError('path-escape', `path escapes sessionsDir: ${path}`)
    }
    let current = this.sessionsDir
    for (const component of internal.split(sep)) {
      current = join(current, component)
      let file: Awaited<ReturnType<typeof lstat>>
      try {
        file = await lstat(current)
      } catch (error) {
        if (isMissing(error)) return false
        throw error
      }
      if (file.isSymbolicLink()) throw new SafeCleanupError('symlink', `symlink is not allowed: ${current}`)
    }
    return true
  }

  private assertOperation(operation: string): asserts operation is SafeCleanupOperation {
    if (!(SAFE_CLEANUP_OPERATIONS as readonly string[]).includes(operation)) {
      throw new SafeCleanupError('invalid-target', `unsupported cleanup operation ${operation}`)
    }
  }
}

async function readHeader(path: string): Promise<Omit<SessionHeader, 'slug' | 'logPath'>> {
  const handle = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < HEADER_LIMIT) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, HEADER_LIMIT - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      const content = buffer.subarray(0, bytesRead)
      const newline = content.indexOf(0x0a)
      chunks.push(newline >= 0 ? content.subarray(0, newline) : content)
      if (newline >= 0) break
      offset += bytesRead
    }
    const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/u, '')
    const value: unknown = JSON.parse(line)
    if (!isRecord(value) || value.kind !== 'header' || typeof value.sessionId !== 'string' || !value.sessionId) {
      throw new Error('invalid header')
    }
    return {
      sessionId: value.sessionId,
      ...(typeof value.parentSessionId === 'string' && value.parentSessionId
        ? { parentSessionId: value.parentSessionId }
        : {}),
    }
  } catch (error) {
    throw new SafeCleanupError(
      'corrupt-header',
      `missing or corrupt first-line header in ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await handle.close()
  }
}

function descendantsOf(targetId: string, headers: readonly SessionHeader[]): SessionHeader[] {
  const selected: SessionHeader[] = []
  const pending = [targetId]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const sessionId = pending.pop()!
    if (visited.has(sessionId)) continue
    visited.add(sessionId)
    const header = headers.find((candidate) => candidate.sessionId === sessionId)
    if (!header) continue
    selected.push(header)
    for (const child of headers) {
      if (child.parentSessionId === sessionId) pending.push(child.sessionId)
    }
  }
  return selected.sort((left, right) => depthOf(right, headers) - depthOf(left, headers)
    || left.sessionId.localeCompare(right.sessionId))
}

function depthOf(header: SessionHeader, headers: readonly SessionHeader[]): number {
  let depth = 0
  let current = header
  const visited = new Set<string>()
  while (current.parentSessionId && !visited.has(current.sessionId)) {
    visited.add(current.sessionId)
    const parent = headers.find((candidate) => candidate.sessionId === current.parentSessionId)
    if (!parent) break
    depth += 1
    current = parent
  }
  return depth
}

function orderLeafFirst(paths: readonly string[], headers: readonly SessionHeader[]): string[] {
  const rank = new Map(headers.map((header, index) => [header.slug, index]))
  return [...paths].sort((left, right) => {
    const leftSlug = artifactOrFileSlug(left)
    const rightSlug = artifactOrFileSlug(right)
    return (rank.get(leftSlug) ?? Number.MAX_SAFE_INTEGER) - (rank.get(rightSlug) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
  })
}

function artifactOrFileSlug(path: string): string {
  const name = basename(path)
  if (!name.includes('.')) return name
  return name
    .replace(/\.jsonl\.summary\.json$/u, '')
    .replace(/\.jsonl\.context\.json$/u, '')
    .replace(/\.snapshot\.json$/u, '')
    .replace(/\.jsonl$/u, '')
}

function toManifestEntry(
  sessionsDir: string,
  path: string,
  file: Awaited<ReturnType<typeof lstat>>,
): SafeCleanupManifestEntry {
  return {
    path: relative(sessionsDir, path).split(sep).join('/'),
    dev: normalizeStatInteger(file.dev, 'dev', path),
    ino: normalizeStatInteger(file.ino, 'ino', path),
    size: Number(file.size),
    mtimeMs: Number(file.mtimeMs),
    type: file.isDirectory() ? 'directory' : 'file',
  }
}

function normalizeStatInteger(value: number | bigint, field: 'dev' | 'ino', path: string): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SafeCleanupError('unsupported-file', `${field} is outside the safe integer range: ${path}`)
    }
    return Number(value)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SafeCleanupError('unsupported-file', `${field} is outside the safe integer range: ${path}`)
  }
  return value
}

function assertSupported(file: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (file.isSymbolicLink()) throw new SafeCleanupError('symlink', `symlink is not allowed: ${path}`)
  if (!file.isFile() && !file.isDirectory()) {
    throw new SafeCleanupError('unsupported-file', `unsupported special file: ${path}`)
  }
}

function assertTargetId(targetId: string): void {
  if (!targetId || targetId === '.' || targetId === '..' || targetId.includes('/') || targetId.includes('\\')) {
    throw new SafeCleanupError('path-escape', `invalid cleanup target id ${targetId}`)
  }
}

async function requireDirectory(path: string): Promise<void> {
  let file: Awaited<ReturnType<typeof lstat>>
  try {
    file = await lstat(path)
  } catch (error) {
    if (isMissing(error)) throw new SafeCleanupError('missing-target', `artifact target does not exist: ${path}`)
    throw error
  }
  assertSupported(file, path)
  if (!file.isDirectory()) throw new SafeCleanupError('unsupported-file', `artifact target is not a directory: ${path}`)
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function parseJournal(value: unknown): CleanupJournal {
  if (!isCleanupJournal(value)) {
    throw new SafeCleanupError('recovery-failed', 'invalid cleanup journal')
  }
  return value
}

function isCleanupJournal(value: unknown): value is CleanupJournal {
  return (
    isRecord(value)
    && value.schemaVersion === 1
    && isRecord(value.plan)
    && typeof value.plan.planId === 'string'
    && typeof value.quarantinePath === 'string'
    && Array.isArray(value.moves)
    && (value.state === 'moving' || value.state === 'completed' || value.state === 'failed')
  )
}

function journalPlanId(error: unknown, name: string): string {
  if (isRecord(error) && typeof error.planId === 'string') return error.planId
  return name.slice(0, -'.json'.length)
}

function hashName(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function resolveActiveSessions(source: ActiveSessionSource): ReadonlySet<string> | readonly string[] {
  return typeof source === 'function' ? source() : source
}

function resolveInternalPath(root: string, path: string): string {
  const resolved = resolve(root, path)
  if (resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw new SafeCleanupError('path-escape', `path escapes storage root: ${path}`)
  }
  return resolved
}

function removesSessionDetails(operation: SafeCleanupOperation): boolean {
  return operation === 'subagent-details' || operation === 'session-tree'
}

async function safePathExists(root: string, path: string): Promise<boolean> {
  const internal = relative(root, path)
  if (!internal || internal === '..' || internal.startsWith(`..${sep}`)) {
    throw new SafeCleanupError('path-escape', `path escapes cleanup root: ${path}`)
  }
  let current = root
  for (const component of internal.split(sep)) {
    current = join(current, component)
    let file: Awaited<ReturnType<typeof lstat>>
    try {
      file = await lstat(current)
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    if (file.isSymbolicLink()) throw new SafeCleanupError('symlink', `symlink is not allowed: ${current}`)
  }
  return true
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
