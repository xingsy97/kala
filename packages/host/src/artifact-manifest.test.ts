import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pruneArtifacts } from './artifact-manifest.js'

describe('pruneArtifacts', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-prune-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function writeArtifact(rel: string, body: string, mtime?: Date): void {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body, 'utf8')
    if (mtime) {
      utimesSync(abs, mtime, mtime)
    }
  }

  it('removes entries older than the age cutoff and preserves fresh ones', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z')
    const oldMtime = new Date('2026-06-01T00:00:00.000Z')
    const freshMtime = new Date('2026-07-08T00:00:00.000Z')
    writeArtifact('traces/session-a.openinference.json', '{"old":true}', oldMtime)
    writeArtifact('traces/session-b.openinference.json', '{"fresh":true}', freshMtime)

    const { report } = await pruneArtifacts({
      rootDir: dir,
      olderThanDays: 14,
      now,
    })

    expect(report.dryRun).toBe(false)
    expect(report.removed.map((r) => r.path)).toEqual(['traces/session-a.openinference.json'])
    expect(report.removed[0]!.reason).toBe('age')
    expect(existsSync(join(dir, 'traces/session-a.openinference.json'))).toBe(false)
    expect(existsSync(join(dir, 'traces/session-b.openinference.json'))).toBe(true)
    expect(report.kept).toBeGreaterThanOrEqual(1)
  })

  it('honours dry-run without removing anything', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z')
    writeArtifact('traces/session-a.openinference.json', 'x', new Date('2020-01-01T00:00:00.000Z'))

    const { report } = await pruneArtifacts({
      rootDir: dir,
      olderThanDays: 1,
      dryRun: true,
      now,
    })

    expect(report.dryRun).toBe(true)
    expect(report.removed).toHaveLength(1)
    expect(existsSync(join(dir, 'traces/session-a.openinference.json'))).toBe(true)
  })

  it('never removes protected paths: prune report, run registry, and worker plans', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z')
    const oldMtime = new Date('2020-01-01T00:00:00.000Z')
    writeArtifact('artifact-prune.json', '{}', oldMtime)
    writeArtifact('registry/run-index.json', '{}', oldMtime)
    writeArtifact('runs/run-abc/worker-plan.json', '{}', oldMtime)
    writeArtifact('traces/session-a.openinference.json', 'x', oldMtime)

    const { report } = await pruneArtifacts({
      rootDir: dir,
      olderThanDays: 1,
      now,
    })

    const removedPaths = report.removed.map((r) => r.path)
    expect(removedPaths).toContain('traces/session-a.openinference.json')
    expect(removedPaths).not.toContain('artifact-manifest.json')
    expect(removedPaths).not.toContain('artifact-prune.json')
    expect(removedPaths).not.toContain('registry/run-index.json')
    expect(removedPaths).not.toContain('runs/run-abc/worker-plan.json')
    const protectedReasons = report.protected.map((p) => p.reason)
    expect(protectedReasons).toEqual(
      expect.arrayContaining(['prune_report', 'run_registry', 'worker_plan']),
    )
  })

  it('enforces a byte budget by removing the oldest eligible entries first', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z')
    writeArtifact('traces/older.openinference.json', 'x'.repeat(500), new Date('2026-06-01T00:00:00.000Z'))
    writeArtifact('traces/middle.openinference.json', 'x'.repeat(500), new Date('2026-06-15T00:00:00.000Z'))
    writeArtifact('traces/newest.openinference.json', 'x'.repeat(500), new Date('2026-07-01T00:00:00.000Z'))

    const { report } = await pruneArtifacts({
      rootDir: dir,
      maxTotalBytes: 700,
      now,
    })

    const removed = report.removed.map((r) => r.path)
    expect(removed).toContain('traces/older.openinference.json')
    expect(removed).toContain('traces/middle.openinference.json')
    expect(removed).not.toContain('traces/newest.openinference.json')
    for (const removal of report.removed) {
      expect(removal.reason).toBe('size_budget')
    }
    expect(report.after.totalBytes).toBeLessThanOrEqual(700)
  })

  it('filters removal candidates by kind when --kinds is set', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z')
    const oldMtime = new Date('2020-01-01T00:00:00.000Z')
    writeArtifact('traces/tr.openinference.json', 'x', oldMtime)
    writeArtifact('rollouts/rl.json', 'x', oldMtime)

    const { report } = await pruneArtifacts({
      rootDir: dir,
      olderThanDays: 1,
      kinds: ['trace'],
      now,
    })

    const removed = report.removed.map((r) => r.path)
    expect(removed).toContain('traces/tr.openinference.json')
    expect(removed).not.toContain('rollouts/rl.json')
    expect(report.policy.kinds).toEqual(['trace'])
  })
})
