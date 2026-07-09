import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AttachedExecutor } from '@agent-kernel/shared'

import { buildExecutorCapabilitySnapshot, writeExecutorCapabilitySnapshot } from './executor-capabilities.js'
import { parseEnhancementCli } from './ops-cli.js'

function exec(overrides: Partial<AttachedExecutor> & { executorId: string }): AttachedExecutor {
  return {
    executorId: overrides.executorId,
    workspaceId: overrides.workspaceId ?? `ws-${overrides.executorId}`,
    workspaceName: overrides.workspaceName ?? `Workspace ${overrides.executorId}`,
    tools: overrides.tools ?? ['bash', 'read', 'write'],
    runtime: overrides.runtime ?? 'node',
    runtimeVersion: overrides.runtimeVersion ?? '20.10.0',
    os: overrides.os ?? 'linux',
    attachedAt: overrides.attachedAt ?? '2026-07-09T10:00:00.000Z',
    ...(overrides.hostname ? { hostname: overrides.hostname } : {}),
    ...(overrides.clientVersion ? { clientVersion: overrides.clientVersion } : {}),
    ...(overrides.sandboxRoots ? { sandboxRoots: overrides.sandboxRoots } : {}),
    ...(overrides.workingDir ? { workingDir: overrides.workingDir } : {}),
  }
}

describe('executor capabilities snapshot', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-executor-caps-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('summarizes runtimes, os, and tool coverage across executors', () => {
    const snapshot = buildExecutorCapabilitySnapshot({
      now: () => new Date('2026-07-09T12:00:00.000Z'),
      executors: [
        exec({ executorId: 'e2', os: 'darwin', tools: ['bash', 'edit'] }),
        exec({ executorId: 'e1', os: 'linux', tools: ['bash', 'read', 'grep'] }),
      ],
    })
    expect(snapshot.generatedAt).toBe('2026-07-09T12:00:00.000Z')
    expect(snapshot.executorCount).toBe(2)
    expect(snapshot.executors.map((e) => e.executorId)).toEqual(['e1', 'e2'])
    expect(snapshot.summary.runtimes).toEqual({ node: 2 })
    expect(snapshot.summary.osCounts).toEqual({ darwin: 1, linux: 1 })
    expect(snapshot.summary.toolCoverage).toEqual({ bash: 2, edit: 1, grep: 1, read: 1 })
  })

  it('writes the snapshot artifact to disk', async () => {
    const { snapshot, snapshotPath } = await writeExecutorCapabilitySnapshot({
      rootDir: dir,
      executors: [exec({ executorId: 'e1' })],
      now: () => new Date('2026-07-09T12:00:00.000Z'),
    })
    expect(snapshotPath).toBe(join(dir, 'executor-capabilities.json'))
    const written = JSON.parse(await readFile(snapshotPath, 'utf8'))
    expect(written.executorCount).toBe(1)
    expect(written).toEqual(snapshot)
  })

  it('records unknown os as separate bucket and omits empty sandbox roots', () => {
    const snapshot = buildExecutorCapabilitySnapshot({
      executors: [{ ...exec({ executorId: 'e1', sandboxRoots: [] }), os: undefined }],
    })
    expect(snapshot.summary.osCounts).toEqual({ unknown: 1 })
    expect(snapshot.executors[0]?.sandboxRoots).toBeUndefined()
  })

  it('parses the CLI verb into an executor-capabilities-snapshot command', () => {
    expect(
      parseEnhancementCli([
        'enhancement',
        'executor-capabilities',
        'snapshot',
        '--root-dir',
        'runs/router/exec-caps',
        '--output',
        'snapshot.json',
      ]),
    ).toMatchObject({
      kind: 'executor-capabilities-snapshot',
      rootDir: 'runs/router/exec-caps',
      outputFilename: 'snapshot.json',
    })
  })
})
