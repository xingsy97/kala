import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { acceptEvaluationRunSpec, canonicalJson, sha256Hex, verifyCanonicalReportModel, type DefectFinding, type EvaluationRunSpec, type TrialEvidence } from '@agent-kernel/eval-protocol'

import { generateEvaluationReport } from './report-generator.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const GENERATED_AT = '2026-08-03T02:00:00.000Z'

async function fixtures() {
  const spec = JSON.parse(await readFile(join(packageRoot, '..', 'eval-protocol', 'fixtures', 'canonical-run-spec-v1.json'), 'utf8')) as EvaluationRunSpec
  const template = JSON.parse(await readFile(join(packageRoot, '..', 'eval-protocol', 'fixtures', 'canonical-trial-result-v1.json'), 'utf8')) as TrialEvidence
  const accepted = await acceptEvaluationRunSpec(spec, '2026-08-03T00:00:01.000Z')
  const trials: TrialEvidence[] = []
  for (const taskId of ['task-one', 'task-two']) for (let repeatIndex = 0; repeatIndex < 3; repeatIndex += 1) trials.push(await evidence(template, taskId, repeatIndex))
  return { accepted, trials }
}

async function evidence(template: TrialEvidence, taskId: string, repeatIndex: number, absolutePath?: string): Promise<TrialEvidence> {
  const output = structuredClone(template)
  const oldTrialId = output.trialId
  output.trialId = output.runId + ':' + taskId + ':' + output.agentVariantId + ':' + String(repeatIndex)
  output.taskId = taskId
  output.repeatIndex = repeatIndex
  output.environmentLock.redactedEnvironment = absolutePath ? { WORKSPACE: absolutePath } : {}
  output.artifactManifest.trialId = output.trialId
  output.artifactManifest.leaseId = 'lease-' + taskId + '-' + String(repeatIndex)
  for (const entry of output.artifactManifest.entries) entry.path = entry.path.replace(oldTrialId, output.trialId)
  output.nativeEventsRef = output.nativeEventsRef.replace(oldTrialId, output.trialId)
  output.normalizedEventsRef = output.normalizedEventsRef.replace(oldTrialId, output.trialId)
  output.analyzerInputRef = output.analyzerInputRef.replace(oldTrialId, output.trialId)
  output.finalDiffRef = output.finalDiffRef.replace(oldTrialId, output.trialId)
  output.stdoutRef = output.stdoutRef.replace(oldTrialId, output.trialId)
  output.stderrRef = output.stderrRef.replace(oldTrialId, output.trialId)
  output.benchmarkResult.rawResultRef = output.benchmarkResult.rawResultRef.replace(oldTrialId, output.trialId)
  const { manifestHash: _oldManifestHash, signature: _signature, ...manifest } = output.artifactManifest
  output.artifactManifest.manifestHash = await sha256Hex(canonicalJson(manifest))
  const { resultHash: _oldResultHash, ...result } = output
  output.resultHash = await sha256Hex(canonicalJson(result))
  return output
}

describe('immutable multi-format report generation', () => {
  it('deterministically generates all seven formats and all ten report sections', async () => {
    const { accepted, trials } = await fixtures()
    const input = { reportId: 'report-golden', methodologyVersion: '1.0.0', generatedAt: GENERATED_AT, runs: [{ accepted, trials }] }
    const first = await generateEvaluationReport(input)
    const second = await generateEvaluationReport({ ...input, runs: [{ accepted, trials: [...trials].reverse() }] })
    expect(second.manifest).toEqual(first.manifest)
    expect(second.files).toEqual(first.files)
    expect(first.manifest.formats.map((value) => value.format)).toEqual(['json', 'csv', 'html', 'pdf', 'junit', 'sarif', 'markdown'])
    expect(first.manifest.formats.map((value) => value.sha256)).toMatchInlineSnapshot(`
      [
        "1b2c4fe5ba8a96db43fcb3b711ff30779cfa1b729d9a529934f1b4a0a774f121",
        "c731b41a1b5b6909bf2b036977516c0ce633e0800f4e2d76df15af20bb98766b",
        "f5438e90e351264e105775d916951850a4790e99dd97d8060b247e180c028206",
        "8759a3a7db5e661fd654cdaca7466b62f69e2db7e210903de85dc6c379511247",
        "4d426fa57bc0e3e7259fe27b91c52891b911db6f121b20cbd16da276d2b415e7",
        "378e8c4be289906638f460578b65113b8238f54cc2f44be009d610d9fe51a48b",
        "ce2614850d4474dbdbe55942f9ffdc43d7cd3d5762e2de757a55bdfa105c7c3f",
      ]
    `)
    const decoder = new TextDecoder()
    const html = decoder.decode(first.files.find((file) => file.format === 'html')!.content)
    const markdown = decoder.decode(first.files.find((file) => file.format === 'markdown')!.content)
    for (let index = 1; index <= 10; index += 1) { expect(html).toContain('<h2>' + String(index) + '.'); expect(markdown).toContain('## ' + String(index) + '.') }
    expect(decoder.decode(first.files.find((file) => file.format === 'pdf')!.content)).toMatch(/^%PDF-1\.4/u)
    expect(html).toContain('methodology://1.0.0/capability/taskSuccess')
    expect(markdown).toContain('| taskSuccess |')
    expect(JSON.parse(decoder.decode(first.files.find((file) => file.format === 'json')!.content))).toMatchObject({ inputEvidenceHash: first.manifest.inputEvidenceHash, trials: { length: 6 }, capabilityVectors: [{ components: { taskSuccess: { methodologyRef: 'methodology://1.0.0/capability/taskSuccess', evidenceRefs: { length: 6 } } } }] })
  })

  it('rejects missing configured repeats and modified evidence hashes', async () => {
    const { accepted, trials } = await fixtures()
    await expect(generateEvaluationReport({ reportId: 'incomplete', methodologyVersion: '1', generatedAt: GENERATED_AT, runs: [{ accepted, trials: trials.slice(1) }] })).rejects.toThrow('every configured trial')
    const tampered = structuredClone(trials); tampered[0]!.benchmarkResult.nativeMetrics.resolved = false
    await expect(generateEvaluationReport({ reportId: 'tampered', methodologyVersion: '1', generatedAt: GENERATED_AT, runs: [{ accepted, trials: tampered }] })).rejects.toThrow('trial evidence hash mismatch')
  })

  it('rejects private absolute paths before producing public report files', async () => {
    const { accepted, trials } = await fixtures()
    trials[0] = await evidence(trials[0]!, trials[0]!.taskId, trials[0]!.repeatIndex, '/home/example/secret-project')
    await expect(generateEvaluationReport({ reportId: 'private', methodologyVersion: '1', generatedAt: GENERATED_AT, runs: [{ accepted, trials }] })).rejects.toThrow('private absolute path')
  })

  it('validates a container-friendly 100+ trial and 50 defect fixture without truncating PDF pages', async () => {
    const { accepted: fixtureAccepted, trials: fixtureTrials } = await fixtures()
    const spec = structuredClone(fixtureAccepted.spec)
    spec.taskPack.evaluatedSlice.selectedItems = 34
    spec.taskPack.evaluatedSlice.coverageRatio = 34 / spec.taskPack.evaluatedSlice.dataset.totalItems
    const accepted = await acceptEvaluationRunSpec(spec, '2026-08-03T00:00:01.000Z')
    const trials: TrialEvidence[] = []
    for (let task = 0; task < 34; task += 1) for (let repeat = 0; repeat < 3; repeat += 1) trials.push(await evidence(fixtureTrials[0]!, 'task-' + String(task).padStart(2, '0'), repeat))
    const defects: DefectFinding[] = Array.from({ length: 50 }, (_, index) => ({
      schemaVersion: 1, findingId: 'finding-' + String(index).padStart(2, '0'), detectorId: 'fixture-detector', detectorVersion: '1.0.0',
      runId: spec.runId, trialId: trials[index]!.trialId, category: 'tool_recovery', severity: index % 10 === 0 ? 'high' : 'medium',
      confidence: 0.9, evidenceRefs: [trials[index]!.resultHash], status: 'detected',
    }))
    const report = await generateEvaluationReport({ reportId: 'container-scale', methodologyVersion: '1.0.0', generatedAt: GENERATED_AT, runs: [{ accepted, trials }], defects })
    const decoder = new TextDecoder()
    const model = await verifyCanonicalReportModel(JSON.parse(decoder.decode(report.files.find((file) => file.format === 'json')!.content)))
    const pdf = decoder.decode(report.files.find((file) => file.format === 'pdf')!.content)
    expect(model.trials).toHaveLength(102)
    expect(model.defects).toHaveLength(50)
    expect(model.semanticHash).toBe(report.manifest.semanticHash)
    expect(pdf).toContain('/Count 3')
    expect(pdf).toContain(trials.at(-1)!.trialId)
  })
})
