#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.length < 2 || args.includes('--help')) {
  console.log('Usage: node scripts/performance/compare-profile-reports.mjs BASELINE.json CANDIDATE.json [--output FILE] [--fail-regression-percent N]')
  process.exit(args.includes('--help') ? 0 : 1)
}
const baselinePath = resolve(args[0])
const candidatePath = resolve(args[1])
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const output = option('--output')
const maxRegressionPercent = Number(option('--fail-regression-percent') ?? 0)
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'))
const scenarios = [...new Set([...Object.keys(baseline.scenarios ?? {}), ...Object.keys(candidate.scenarios ?? {})])]
const rows = []
const regressions = []

for (const scenario of scenarios) {
  const before = baseline.scenarios?.[scenario]
  const after = candidate.scenarios?.[scenario]
  if (!before || !after) continue
  for (const metric of [
    ['durationMs', (value) => value.durationMs],
    ['domNodes', (value) => value.domNodes],
    ['maxLongTaskMs', (value) => Math.max(...(value.longTasks ?? []).map((item) => item.duration), 0)],
    ['maxFrameMs', (value) => value.frames?.maxMs ?? 0],
    ['p95FrameMs', (value) => value.frames?.p95Ms ?? 0],
    ['framesOver50Ms', (value) => value.frames?.over50Ms ?? 0],
  ]) {
    const beforeValue = metric[1](before)
    const afterValue = metric[1](after)
    if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue)) continue
    const changePercent = beforeValue === 0 ? (afterValue === 0 ? 0 : Infinity) : (afterValue - beforeValue) / beforeValue * 100
    const row = { scenario, metric: metric[0], before: beforeValue, after: afterValue, changePercent }
    rows.push(row)
    if (maxRegressionPercent > 0 && changePercent > maxRegressionPercent) regressions.push(row)
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  baseline: { path: baselinePath, artifact: baseline.artifactMetadata ?? baseline.artifact },
  candidate: { path: candidatePath, artifact: candidate.artifactMetadata ?? candidate.artifact },
  maxRegressionPercent,
  pass: regressions.length === 0,
  regressions,
  rows,
}
const markdown = [
  `# Performance A/B: ${basename(baselinePath)} → ${basename(candidatePath)}`,
  '',
  '| Scenario | Metric | Before | After | Change |',
  '|---|---|---:|---:|---:|',
  ...rows.map((row) => `| ${row.scenario} | ${row.metric} | ${format(row.before)} | ${format(row.after)} | ${formatPercent(row.changePercent)} |`),
  '',
  regressions.length ? `Regressions over ${maxRegressionPercent}%: ${regressions.length}` : 'No configured regressions detected.',
].join('\n')
if (output) writeFileSync(resolve(output), output.endsWith('.md') ? `${markdown}\n` : `${JSON.stringify(report, null, 2)}\n`)
console.log(markdown)
if (!report.pass) process.exitCode = 1

function format(value) { return Number.isInteger(value) ? String(value) : value.toFixed(1) }
function formatPercent(value) { return value === Infinity ? '+∞' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%` }
