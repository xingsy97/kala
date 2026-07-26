import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BenchmarkRunService } from './benchmark-run-service.js'

describe('BenchmarkRunService', () => {
  it('persists sequenced lifecycle and runs multiple backend configurations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-service-'))
    const repo = join(root, 'repo')
    await mkdir(repo)
    await writeFile(join(repo, 'a.txt'), 'before\n')
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init'], { cwd: repo })
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'], { cwd: repo })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const instances = join(root, 'instances.jsonl')
    await writeFile(instances, `${JSON.stringify({ instance_id: 'local__one', repo_path: repo, base_commit: commit, problem_statement: 'change a' })}\n`)
    const service = new BenchmarkRunService(root)
    await service.create({
      schemaVersion: 1,
      runId: 'multi-backend-fixture',
      benchmark: 'swebench',
      dataset: { source: 'local', instancesJsonl: instances },
      backends: [
        { id: 'smoke', model: '', config: {} },
        { id: 'custom-command', model: 'fixture', label: 'writer', config: { command: "printf 'after\\n' > a.txt" } },
      ],
      execution: { maxWorkers: 1, maxTurns: 1, timeoutMs: 10_000, retryLimit: 0, skipCompleted: false },
      grading: { mode: 'deferred' },
      createdAt: '2026-07-26T00:00:00.000Z',
    })
    const result = await service.run('multi-backend-fixture')
    expect(result.status.state).toBe('predictions_ready')
    expect(result.status.backends.map((backend) => backend.state)).toEqual(['predictions_ready', 'predictions_ready'])
    expect(result.status.backends[0]?.failed).toBe(1)
    expect(result.status.backends[1]?.completed).toBe(1)
    const events = await service.events('multi-backend-fixture')
    expect(events.events.map((event) => event.seq)).toEqual(events.events.map((_event, index) => index))
    expect(events.events.map((event) => event.type)).toContain('run.predictions_ready')
    const impact = await service.deletionImpact('multi-backend-fixture')
    expect(impact.files).toBeGreaterThan(2)
    const deleted = await service.delete('multi-backend-fixture')
    expect(deleted.files).toBe(impact.files)
    await expect(service.get('multi-backend-fixture')).rejects.toThrow()
  })
})

