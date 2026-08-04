import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadDetectorPlugins } from './detector-plugins.js'

describe('external detector plugin loader', () => {
  it('loads a public SDK detector module and validates finding identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-detector-plugin-'))
    const modulePath = join(directory, 'plugin.mjs')
    const sdkUrl = new URL('../../eval-sdk/dist/index.js', import.meta.url).href
    await writeFile(modulePath, `import { DefectDetectorDescriptorSchema, DefectFindingSchema, defineDefectDetectorPlugin } from ${JSON.stringify(sdkUrl)}
const descriptor = DefectDetectorDescriptorSchema.parse({ schemaVersion: 1, protocolVersions: [1], id: 'example:sample-detector', version: '1.0.0', capabilities: ['analyze'] })
export const evaluationPlugins = [defineDefectDetectorPlugin({ kind: 'defect-detector', descriptor, create: () => ({ descriptor, async analyze(input) { return [DefectFindingSchema.parse({ schemaVersion: 1, findingId: 'sample-finding', detectorId: descriptor.id, detectorVersion: descriptor.version, runId: input.runId, trialId: input.trialId, category: 'unknown', severity: 'low', confidence: 1, evidenceRefs: ['sample:evidence'], status: 'detected' })] } }) })]
`)
    const registry = await loadDetectorPlugins([modulePath])
    const findings = await registry.analyze('example:sample-detector', { runId: 'run', trialId: 'trial' } as never)
    expect(findings).toEqual([expect.objectContaining({ detectorId: 'example:sample-detector', runId: 'run', trialId: 'trial' })])
  })
})
