import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertPluginMatchesDescriptor, negotiateEvaluationPlugin, type EvaluationPlugin } from '@agent-kernel/eval-sdk'

import type { WorkerRuntimeRegistry } from './registry.js'

export async function loadWorkerPlugins(specifiers: readonly string[], registry: WorkerRuntimeRegistry): Promise<void> {
  for (const specifier of specifiers) {
    const url = pluginUrl(specifier)
    await assertPublicImports(url)
    const module = await import(isolatedUrl(url)) as Record<string, unknown>
    const plugins = module.evaluationPlugins
    if (!Array.isArray(plugins) || plugins.length === 0) throw new Error('plugin module must export a non-empty evaluationPlugins array: ' + specifier)
    for (const candidate of plugins) registerPlugin(candidate, registry, specifier)
  }
}

function registerPlugin(candidate: unknown, registry: WorkerRuntimeRegistry, source: string): void {
  if (!candidate || typeof candidate !== 'object') throw new Error('invalid evaluation plugin from ' + source)
  const plugin = candidate as EvaluationPlugin
  if (typeof plugin.create !== 'function' || !plugin.descriptor) throw new Error('invalid evaluation plugin from ' + source)
  negotiateEvaluationPlugin(plugin, { requireNamespacedId: !isPlatformBuiltinSource(source) })
  assertPluginMatchesDescriptor(plugin)
  if (plugin.kind === 'sandbox-provider') registry.registerSandbox(plugin.create())
  else if (plugin.kind === 'agent-backend') registry.registerAgent(plugin.create())
  else if (plugin.kind === 'benchmark-adapter') registry.registerBenchmark(plugin.create())
  else throw new Error('Worker cannot load plugin kind ' + String(plugin.kind) + ' from ' + source)
}

function isPlatformBuiltinSource(source: string): boolean {
  return /^\/plugins\/[a-z0-9-]+\/dist\//u.test(source)
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
