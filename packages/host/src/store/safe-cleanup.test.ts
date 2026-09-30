import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SafeCleanupEngine } from './safe-cleanup.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): {
  root: string
  sessionsDir: string
  quarantineDir: string
  metadataDir: string
  engine: SafeCleanupEngine
} {
  const root = mkdtempSync(join(process.cwd(), '.kala-safe-cleanup-'))
  roots.push(root)
  const sessionsDir = join(root, 'sessions')
  const quarantineDir = join(root, 'quarantine')
  const metadataDir = join(root, 'metadata')
  mkdirSync(sessionsDir)
  mkdirSync(quarantineDir)
  const engine = new SafeCleanupEngine({ sessionsDir, quarantineDir, metadataDir })
  return { root, sessionsDir, quarantineDir, metadataDir, engine }
}

function session(
  sessionsDir: string,
  slug: string,
  sessionId: string,
  parentSessionId?: string,
): void {
  writeFileSync(join(sessionsDir, `${slug}.jsonl`), `${JSON.stringify({
    kind: 'header',
    seq: 0,
    ts: '2026-09-30T00:00:00.000Z',
    sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
  })}\n`)
  writeFileSync(join(sessionsDir, `${slug}.snapshot.json`), `snapshot-${sessionId}`)
  writeFileSync(join(sessionsDir, `${slug}.jsonl.summary.json`), `summary-${sessionId}`)
  writeFileSync(join(sessionsDir, `${slug}.jsonl.context.json`), `context-${sessionId}`)
  const artifacts = join(sessionsDir, 'artifacts', slug, 'effects')
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, '1.json'), `artifact-${sessionId}`)
}

describe('SafeCleanupEngine', () => {
  it('rejects active targets and active descendants', async () => {
    const { sessionsDir, engine } = fixture()
    session(sessionsDir, 'root-slug', 'root')
    session(sessionsDir, 'child-slug', 'child', 'root')

    await expect(engine.prepare('session-tree', 'root', ['root']))
      .rejects.toMatchObject({ code: 'active-session' })
    await expect(engine.prepare('session-tree', 'root', ['child']))
      .rejects.toMatchObject({ code: 'active-session' })

    const plan = await engine.prepare('session-tree', 'root', [])
    await expect(engine.execute(plan.planId, ['child']))
      .rejects.toMatchObject({ code: 'active-session' })
    expect(existsSync(join(sessionsDir, 'root-slug.jsonl'))).toBe(true)
  })

  it('rejects root sessions for subagent-details', async () => {
    const { sessionsDir, engine } = fixture()
    session(sessionsDir, 'root-slug', 'root')

    await expect(engine.prepare('subagent-details', 'root', []))
      .rejects.toMatchObject({ code: 'root-session' })
  })

  it('does not let an unrelated corrupt log block subagent cleanup', async () => {
    const { sessionsDir, engine } = fixture()
    session(sessionsDir, 'root-slug', 'root')
    session(sessionsDir, 'child-slug', 'child', 'root')
    const corruptPath = join(sessionsDir, 'unrelated-corrupt.jsonl')
    writeFileSync(corruptPath, '{"kind":"header","sessionId":"unterminated')

    const plan = await engine.prepare('subagent-details', 'child', [])
    expect(plan.sessionIds).toEqual(['child'])
    await expect(engine.execute(plan.planId, [])).resolves.toMatchObject({
      logicalDeletion: true,
    })
    expect(existsSync(corruptPath)).toBe(true)
  })

  it('leaves an unreadable possible descendant untouched during tree cleanup', async () => {
    const { sessionsDir, engine } = fixture()
    session(sessionsDir, 'root-slug', 'root')
    session(sessionsDir, 'child-slug', 'child', 'root')
    const corruptPath = join(sessionsDir, 'unknown-descendant.jsonl')
    writeFileSync(corruptPath, '{"kind":"header","sessionId":"unknown","parentSessionId":"root')

    const plan = await engine.prepare('session-tree', 'root', [])
    expect(plan.sessionIds).toEqual(['child', 'root'])
    await expect(engine.execute(plan.planId, [])).resolves.toMatchObject({
      logicalDeletion: true,
    })
    expect(existsSync(corruptPath)).toBe(true)
  })

  it('refuses mutation after prepare without renaming anything', async () => {
    const { sessionsDir, quarantineDir, engine } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    const plan = await engine.prepare('subagent-details', 'child', [])
    writeFileSync(join(sessionsDir, 'child-slug.snapshot.json'), 'changed-after-prepare')

    await expect(engine.execute(plan.planId, [])).rejects.toMatchObject({ code: 'manifest-changed' })
    expect(existsSync(join(sessionsDir, 'child-slug.jsonl'))).toBe(true)
    expect(readdirSync(quarantineDir)).toEqual([])
  })

  it('refuses a session tree whose descendant topology changed after prepare', async () => {
    const { sessionsDir, quarantineDir, engine } = fixture()
    session(sessionsDir, 'root-slug', 'root')
    session(sessionsDir, 'child-slug', 'child', 'root')
    const plan = await engine.prepare('session-tree', 'root', [])
    session(sessionsDir, 'late-child-slug', 'late-child', 'child')

    await expect(engine.execute(plan.planId, [])).rejects.toMatchObject({ code: 'manifest-changed' })
    expect(existsSync(join(sessionsDir, 'root-slug.jsonl'))).toBe(true)
    expect(existsSync(join(sessionsDir, 'late-child-slug.jsonl'))).toBe(true)
    expect(readdirSync(quarantineDir)).toEqual([])
  })

  it('rechecks active state only after acquiring the mutation lease', async () => {
    const { sessionsDir, quarantineDir, metadataDir } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    let leased = false
    const engine = new SafeCleanupEngine({
      sessionsDir,
      quarantineDir,
      metadataDir,
      withMutationLease: async (_sessionIds, action) => {
        leased = true
        try {
          return await action()
        } finally {
          leased = false
        }
      },
    })
    const plan = await engine.prepare('subagent-details', 'child', [])

    await expect(engine.execute(plan.planId, () => leased ? ['child'] : []))
      .rejects.toMatchObject({ code: 'active-session' })
    expect(existsSync(join(sessionsDir, 'child-slug.jsonl'))).toBe(true)
  })

  it('revalidates the manifest immediately before the first quarantine move', async () => {
    const { sessionsDir, quarantineDir, engine } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    const plan = await engine.prepare('subagent-details', 'child', [])
    let checks = 0

    await expect(engine.execute(plan.planId, () => {
      checks += 1
      if (checks === 2) writeFileSync(join(sessionsDir, 'child-slug.snapshot.json'), 'changed-at-final-check')
      return []
    })).rejects.toMatchObject({ code: 'manifest-changed' })

    expect(existsSync(join(sessionsDir, 'child-slug.jsonl'))).toBe(true)
    expect(readdirSync(quarantineDir)).toHaveLength(1)
  })

  it('rejects symlinks and path escape targets', async () => {
    const { root, sessionsDir, engine } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    writeFileSync(join(root, 'outside'), 'outside')
    symlinkSync(join(root, 'outside'), join(sessionsDir, 'artifacts', 'child-slug', 'linked'))

    await expect(engine.prepare('subagent-details', 'child', []))
      .rejects.toMatchObject({ code: 'symlink' })
    await expect(engine.prepare('orphan-artifacts', '../outside', []))
      .rejects.toMatchObject({ code: 'path-escape' })
  })

  it('writes a durable tombstone before quarantining subagent details', async () => {
    const { sessionsDir, quarantineDir, metadataDir, engine } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    const plan = await engine.prepare('subagent-details', 'child', [])
    const result = await engine.execute(plan.planId, [])

    expect(result.logicalDeletion).toBe(true)
    expect(result.bytesQuarantined).toBe(plan.estimatedBytes)
    expect(existsSync(join(sessionsDir, 'child-slug.jsonl'))).toBe(false)
    expect(readdirSync(join(metadataDir, 'tombstones'))).toHaveLength(1)
    const tombstone = JSON.parse(readFileSync(
      join(metadataDir, 'tombstones', readdirSync(join(metadataDir, 'tombstones'))[0]!),
      'utf8',
    ))
    expect(tombstone).toMatchObject({ sessionId: 'child', operation: 'subagent-details', planId: plan.planId })
    expect(readdirSync(join(quarantineDir, plan.planId)).length).toBeGreaterThan(0)
  })

  it('quarantines a session tree leaves-first including detail artifacts', async () => {
    const { sessionsDir, quarantineDir, metadataDir, engine } = fixture()
    session(sessionsDir, 'root-slug', 'root')
    session(sessionsDir, 'child-slug', 'child', 'root')
    session(sessionsDir, 'leaf-slug', 'leaf', 'child')
    const plan = await engine.prepare('session-tree', 'root', [])

    expect(plan.sessionIds).toEqual(['leaf', 'child', 'root'])
    expect(plan.manifest.some((entry) => entry.path === 'artifacts/leaf-slug/effects/1.json')).toBe(true)
    await engine.execute(plan.planId, [])
    expect(existsSync(join(sessionsDir, 'root-slug.jsonl'))).toBe(false)
    expect(existsSync(join(sessionsDir, 'child-slug.jsonl'))).toBe(false)
    expect(existsSync(join(sessionsDir, 'leaf-slug.jsonl'))).toBe(false)
    expect(readdirSync(join(quarantineDir, plan.planId)).length).toBe(15)
    expect(await engine.listTombstonedSessionIds()).toEqual(['child', 'leaf', 'root'])
    expect(readdirSync(join(metadataDir, 'tombstones'))).toHaveLength(1)
  })

  it('returns the same result for idempotent repeated execute', async () => {
    const { sessionsDir, engine } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    const plan = await engine.prepare('subagent-details', 'child', [])

    const first = await engine.execute(plan.planId, [])
    const second = await engine.execute(plan.planId, ['child'])
    expect(second).toEqual(first)
  })

  it('recovers a synthetic partial journal deterministically', async () => {
    const { sessionsDir, quarantineDir, metadataDir } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    const preparing = new SafeCleanupEngine({ sessionsDir, quarantineDir, metadataDir })
    const plan = await preparing.prepare('subagent-details', 'child', [])
    const planQuarantine = join(quarantineDir, plan.planId)
    mkdirSync(planQuarantine)
    const source = plan.topLevelPaths[0]!
    const quarantineName = `0000-${source.split('/').at(-1)}`
    const journal = {
      schemaVersion: 1,
      plan,
      state: 'moving',
      quarantinePath: planQuarantine,
      moves: plan.topLevelPaths.map((sourcePath, index) => ({
        sourcePath,
        quarantineName: `${String(index).padStart(4, '0')}-${sourcePath.split('/').at(-1)}`,
        state: index === 0 ? 'moved' : 'pending',
      })),
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    }
    mkdirSync(join(metadataDir, 'journals'), { recursive: true })
    writeFileSync(join(metadataDir, 'journals', `${plan.planId}.json`), JSON.stringify(journal))
    const { renameSync } = await import('node:fs')
    renameSync(source, join(planQuarantine, quarantineName))

    const recovering = new SafeCleanupEngine({ sessionsDir, quarantineDir, metadataDir })
    const recovered = await recovering.recover()
    expect(recovered).toMatchObject([{ planId: plan.planId, status: 'completed' }])
    for (const path of plan.topLevelPaths) expect(existsSync(path)).toBe(false)
    const repeated = await recovering.execute(plan.planId, [])
    expect(repeated.logicalDeletion).toBe(true)
    expect(readdirSync(join(metadataDir, 'tombstones'))).toHaveLength(1)
    expect(existsSync(join(metadataDir, 'audit', `${plan.planId}.json`))).toBe(true)
    expect(JSON.parse(readFileSync(join(metadataDir, 'journals', `${plan.planId}.json`), 'utf8')))
      .toMatchObject({ state: 'completed' })
  })

  it('fails recovery without moving a remaining source changed after the journal was written', async () => {
    const { sessionsDir, quarantineDir, metadataDir } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    const preparing = new SafeCleanupEngine({ sessionsDir, quarantineDir, metadataDir })
    const plan = await preparing.prepare('subagent-details', 'child', [])
    const planQuarantine = join(quarantineDir, plan.planId)
    mkdirSync(planQuarantine)
    const journal = {
      schemaVersion: 1,
      plan,
      state: 'moving',
      quarantinePath: planQuarantine,
      moves: plan.topLevelPaths.map((sourcePath, index) => ({
        sourcePath,
        quarantineName: `${String(index).padStart(4, '0')}-${sourcePath.split('/').at(-1)}`,
        state: index === 0 ? 'moved' : 'pending',
      })),
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    }
    mkdirSync(join(metadataDir, 'journals'), { recursive: true })
    writeFileSync(join(metadataDir, 'journals', `${plan.planId}.json`), JSON.stringify(journal))
    const { renameSync } = await import('node:fs')
    renameSync(plan.topLevelPaths[0]!, join(planQuarantine, journal.moves[0]!.quarantineName))
    const changedSource = plan.topLevelPaths.slice(1).find((path) => lstatSync(path).isFile())!
    appendFileSync(changedSource, 'changed-after-crash')

    const recovering = new SafeCleanupEngine({ sessionsDir, quarantineDir, metadataDir })
    await expect(recovering.recover()).resolves.toMatchObject([{
      planId: plan.planId,
      status: 'failed',
      error: expect.stringContaining('changed'),
    }])
    expect(existsSync(changedSource)).toBe(true)
    expect(JSON.parse(readFileSync(join(metadataDir, 'journals', `${plan.planId}.json`), 'utf8')))
      .toMatchObject({ state: 'failed' })
  })

  it('fails recovery when an already moved quarantine target changed', async () => {
    const { sessionsDir, quarantineDir, metadataDir } = fixture()
    session(sessionsDir, 'child-slug', 'child', 'root')
    const preparing = new SafeCleanupEngine({ sessionsDir, quarantineDir, metadataDir })
    const plan = await preparing.prepare('subagent-details', 'child', [])
    const planQuarantine = join(quarantineDir, plan.planId)
    mkdirSync(planQuarantine)
    const source = plan.topLevelPaths.find((path) => lstatSync(path).isFile())!
    const sourceIndex = plan.topLevelPaths.indexOf(source)
    const quarantineName = `${String(sourceIndex).padStart(4, '0')}-${source.split('/').at(-1)}`
    const journal = {
      schemaVersion: 1,
      plan,
      state: 'moving',
      quarantinePath: planQuarantine,
      moves: plan.topLevelPaths.map((sourcePath, index) => ({
        sourcePath,
        quarantineName: `${String(index).padStart(4, '0')}-${sourcePath.split('/').at(-1)}`,
        state: index === sourceIndex ? 'moved' : 'pending',
      })),
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    }
    mkdirSync(join(metadataDir, 'journals'), { recursive: true })
    writeFileSync(join(metadataDir, 'journals', `${plan.planId}.json`), JSON.stringify(journal))
    const { renameSync } = await import('node:fs')
    const destination = join(planQuarantine, quarantineName)
    renameSync(source, destination)
    appendFileSync(destination, 'tampered-in-quarantine')

    const recovering = new SafeCleanupEngine({ sessionsDir, quarantineDir, metadataDir })
    await expect(recovering.recover()).resolves.toMatchObject([{
      planId: plan.planId,
      status: 'failed',
      error: expect.stringContaining('changed'),
    }])
    expect(existsSync(destination)).toBe(true)
    expect(JSON.parse(readFileSync(join(metadataDir, 'journals', `${plan.planId}.json`), 'utf8')))
      .toMatchObject({ state: 'failed' })
  })

  it('prepares exact orphan and derived artifact plans', async () => {
    const { sessionsDir, engine } = fixture()
    session(sessionsDir, 'root-slug', 'root')
    const orphan = join(sessionsDir, 'artifacts', 'orphan-id')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'one.json'), 'one')

    const derived = await engine.prepare('derived-artifacts', 'root', [])
    expect(derived.manifest.every((entry) => entry.path.startsWith('artifacts/root-slug'))).toBe(true)
    const orphanPlan = await engine.prepare('orphan-artifacts', 'orphan-id', [])
    expect(orphanPlan.manifest.map((entry) => entry.path)).toContain('artifacts/orphan-id/one.json')
  })

  it('prepares an orphan plan without parsing unrelated corrupt session logs', async () => {
    const { sessionsDir, engine } = fixture()
    writeFileSync(join(sessionsDir, 'unrelated-corrupt.jsonl'), '{"kind":"header","sessionId":"unterminated')
    const orphan = join(sessionsDir, 'artifacts', 'orphan-id')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'one.json'), 'one')

    const plan = await engine.prepare('orphan-artifacts', 'orphan-id', [])

    expect(plan.targetId).toBe('orphan-id')
    expect(plan.manifest.map((entry) => entry.path)).toContain('artifacts/orphan-id/one.json')
  })

  it('refuses orphan cleanup when a matching session log exists before or after prepare', async () => {
    const before = fixture()
    mkdirSync(join(before.sessionsDir, 'artifacts', 'claimed'), { recursive: true })
    writeFileSync(join(before.sessionsDir, 'artifacts', 'claimed', 'one.json'), 'one')
    writeFileSync(join(before.sessionsDir, 'claimed.jsonl'), '{"kind":"header","sessionId":"unterminated')
    await expect(before.engine.prepare('orphan-artifacts', 'claimed', []))
      .rejects.toMatchObject({ code: 'invalid-target' })

    const after = fixture()
    mkdirSync(join(after.sessionsDir, 'artifacts', 'late-claim'), { recursive: true })
    writeFileSync(join(after.sessionsDir, 'artifacts', 'late-claim', 'one.json'), 'one')
    const plan = await after.engine.prepare('orphan-artifacts', 'late-claim', [])
    writeFileSync(join(after.sessionsDir, 'late-claim.jsonl'), '{"kind":"header","sessionId":"unterminated')

    await expect(after.engine.execute(plan.planId, [])).rejects.toMatchObject({ code: 'invalid-target' })
    expect(existsSync(join(after.sessionsDir, 'artifacts', 'late-claim', 'one.json'))).toBe(true)
    expect(readdirSync(after.quarantineDir)).toEqual([])
  })

  it('does not tombstone or evict live sessions after derived artifact cleanup', async () => {
    const { sessionsDir, quarantineDir, metadataDir } = fixture()
    session(sessionsDir, 'root-slug', 'root')
    const quarantined: string[][] = []
    const engine = new SafeCleanupEngine({
      sessionsDir,
      quarantineDir,
      metadataDir,
      onSessionsQuarantined: (sessionIds) => { quarantined.push([...sessionIds]) },
    })
    const plan = await engine.prepare('derived-artifacts', 'root', [])

    await engine.execute(plan.planId, [])

    expect(quarantined).toEqual([])
    expect(await engine.listTombstonedSessionIds()).toEqual([])
    expect(existsSync(join(sessionsDir, 'root-slug.jsonl'))).toBe(true)
  })
})
