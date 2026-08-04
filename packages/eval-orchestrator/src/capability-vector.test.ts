import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { TrialEvidence } from '@agent-kernel/eval-protocol'
import { deriveCapabilityVector } from './capability-vector.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('normalized capability vector methodology', () => {
  it('derives all eleven components with detector/verifier and methodology links', async () => {
    const trial = JSON.parse(await readFile(join(packageRoot, '..', 'eval-protocol', 'fixtures', 'canonical-trial-result-v1.json'), 'utf8')) as TrialEvidence
    trial.benchmarkResult.nativeMetrics = { resolved: true, file_recall_at_k: 0.8, recovery_action_grounded: true, recovered: true, memory_recall: 0.75, plan_execution_alignment: 0.9, verifier_protocol_valid: true }
    const vector = deriveCapabilityVector({ runId: trial.runId, agentVariantId: trial.agentVariantId, methodologyVersion: '1.0.0', trials: [trial] })
    expect(Object.keys(vector.components)).toHaveLength(11)
    expect(vector.components.codeUnderstanding.score).toBe(0.8)
    for (const component of Object.values(vector.components)) {
      expect(component.methodologyRef.startsWith('methodology://1.0.0/capability/')).toBe(true)
      expect(component.detectorIds.length + component.verifierIds.length).toBeGreaterThan(0)
      expect(component.evidenceRefs).toEqual([trial.resultHash])
    }
  })
})
