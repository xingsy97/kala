#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = new URL('../..', import.meta.url).pathname
const requireFromPerfHarness = createRequire(new URL('../../packages/perf-harness/package.json', import.meta.url))
const { SourceMapConsumer } = requireFromPerfHarness('source-map')
const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.length === 0 || args.includes('--help')) {
  console.log('Usage: node scripts/performance/analyze-cpu-profile.mjs PROFILE... [--maps DIR] [--output FILE] [--top N]')
  process.exit(args.length === 0 ? 1 : 0)
}
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const mapDir = resolve(option('--maps') ?? join(root, 'packages/dashboard/dist/assets'))
const output = option('--output')
const topN = Number(option('--top') ?? 30)
const profiles = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--maps' && args[index - 1] !== '--output' && args[index - 1] !== '--top').map(resolve)
if (!existsSync(mapDir)) throw new Error(`source-map directory not found: ${mapDir}`)

const maps = new Map()
for (const file of readdirSync(mapDir).filter((name) => name.endsWith('.js.map'))) {
  try { maps.set(file.slice(0, -4), await new SourceMapConsumer(JSON.parse(readFileSync(join(mapDir, file), 'utf8')))) } catch {}
}
if (maps.size === 0) throw new Error(`no source maps found in ${mapDir}; rebuild with RUNLAB_PROFILE_SOURCEMAP=1`)

const reports = []
for (const path of profiles) {
  const profile = JSON.parse(readFileSync(path, 'utf8'))
  const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node.callFrame]))
  const totals = new Map()
  for (let index = 0; index < (profile.samples ?? []).length; index += 1) {
    const frame = nodes.get(profile.samples[index])
    if (!frame) continue
    const file = basename(frame.url ?? '')
    const map = maps.get(file)
    let functionName = frame.functionName || '(anonymous)'
    let source = file || '(native)'
    let line = frame.lineNumber >= 0 ? frame.lineNumber + 1 : null
    if (map) {
      const original = map.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber })
      functionName = original.name ?? functionName
      source = original.source ?? source
      line = original.line ?? line
    }
    const key = JSON.stringify([functionName, source, line])
    const current = totals.get(key) ?? { functionName, source, line, selfMs: 0 }
    current.selfMs += Math.max(0, profile.timeDeltas?.[index] ?? 0) / 1000
    totals.set(key, current)
  }
  const hotSpots = [...totals.values()].sort((left, right) => right.selfMs - left.selfMs).slice(0, topN).map((item) => ({ ...item, selfMs: Math.round(item.selfMs * 10) / 10 }))
  reports.push({ profile: path, sourceMapped: true, hotSpots })
}
for (const map of maps.values()) map.destroy()

const report = { generatedAt: new Date().toISOString(), mapDir, profiles: reports }
const markdown = reports.map((item) => `## ${basename(item.profile)}\n\n${item.hotSpots.map((hot) => `- ${hot.selfMs.toFixed(1)} ms — \`${hot.functionName}\` — ${hot.source}${hot.line ? `:${hot.line}` : ''}`).join('\n')}`).join('\n\n')
if (output) {
  mkdirSync(resolve(output, '..'), { recursive: true })
  writeFileSync(resolve(output), output.endsWith('.md') ? `${markdown}\n` : `${JSON.stringify(report, null, 2)}\n`)
}
console.log(markdown)
