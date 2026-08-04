import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DefectFindingSchema, type AnalyzerInput, type DefectDetector, type DefectFinding } from '@agent-kernel/eval-protocol'
import { assertPluginMatchesDescriptor, negotiateEvaluationPlugin, type DefectDetectorPlugin } from '@agent-kernel/eval-sdk'

export type AnalyzerDefectDetector = DefectDetector<AnalyzerInput, unknown, unknown>

export class DetectorPluginRegistry {
  private readonly detectors = new Map<string, AnalyzerDefectDetector>()

  register(plugin: DefectDetectorPlugin<AnalyzerInput, unknown, unknown>): void {
    negotiateEvaluationPlugin(plugin)
    assertPluginMatchesDescriptor(plugin)
    if (this.detectors.has(plugin.descriptor.id)) throw new Error('duplicate defect detector: ' + plugin.descriptor.id)
    this.detectors.set(plugin.descriptor.id, plugin.create())
  }

  has(detectorId: string): boolean { return this.detectors.has(detectorId) }

  async analyze(detectorId: string, input: AnalyzerInput): Promise<DefectFinding[]> {
    const detector = this.detectors.get(detectorId)
    if (!detector) throw new Error('unknown detector plugin: ' + detectorId)
    const findings = await detector.analyze(input)
    return findings.map((finding) => {
      const parsed = DefectFindingSchema.parse(finding)
      if (parsed.detectorId !== detector.descriptor.id || parsed.detectorVersion !== detector.descriptor.version) {
        throw new Error('defect detector output descriptor mismatch: ' + detectorId)
      }
      if (parsed.runId !== input.runId || parsed.trialId !== input.trialId) throw new Error('defect detector output input identity mismatch: ' + detectorId)
      return parsed
    })
  }
}

export async function loadDetectorPlugins(specifiers: readonly string[]): Promise<DetectorPluginRegistry> {
  const registry = new DetectorPluginRegistry()
  for (const specifier of specifiers) {
    const url = pluginUrl(specifier)
    await assertPublicImports(url)
    const module = await import(isolatedUrl(url)) as Record<string, unknown>
    const plugins = module.evaluationPlugins
    if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('plugin module must export a non-empty evaluationPlugins array: ' + specifier)
    for (const candidate of plugins) {
      if (!candidate || typeof candidate !== 'object' || (candidate as { kind?: unknown }).kind !== 'defect-detector') {
        throw new Error('Analyzer plugin module contains a non-detector plugin: ' + specifier)
      }
      registry.register(candidate as DefectDetectorPlugin<AnalyzerInput, unknown, unknown>)
    }
  }
  return registry
}

function pluginUrl(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(specifier)) return pathToFileURL(resolve(specifier)).href
  return import.meta.resolve(specifier)
}

function isolatedUrl(url: string): string { const isolated = new URL(url); isolated.searchParams.set('evaluation-plugin', crypto.randomUUID()); return isolated.href }

async function assertPublicImports(url: string, visited = new Set<string>()): Promise<void> {
  const clean = new URL(url); clean.search = ''; clean.hash = ''
  if (clean.protocol !== 'file:' || visited.has(clean.href)) return
  visited.add(clean.href)
  const source = await readFile(fileURLToPath(clean), 'utf8')
  const imports = [...source.matchAll(/(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier): specifier is string => typeof specifier === 'string')
  for (const specifier of imports) {
    if (/^@agent-kernel\/(?:eval-(?:worker|analyzer|orchestrator)|host)(?:\/|$)/u.test(specifier) || /^@agent-kernel\/eval-sdk\//u.test(specifier)) throw new Error('private evaluation plugin import is forbidden: ' + specifier)
    if (specifier.startsWith('.')) await assertPublicImports(new URL(specifier, clean).href, visited)
  }
}
