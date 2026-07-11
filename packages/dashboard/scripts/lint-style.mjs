#!/usr/bin/env node
// Ratchet-based STYLE.md audit. Rules and rationale live in
// packages/dashboard/STYLE.md  - 11. We can't fail-on-any today (the tree has
// ~450 legacy hits), so this script snapshots counts and only fails when a
// count goes UP. Ratchet the baseline down whenever you clean up hits.
//
// Update baseline: `node scripts/lint-style.mjs --write`

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const baselinePath = join(here, 'lint-style.baseline.json')

const RULES = [
  {
    id: 'bare-border',
    pattern: '\\bborder\\b(?![-a-zA-Z/])',
    hint: 'Use border-border/50, /60, or drop it for a bg step (STYLE.md  - 2).',
  },
  {
    id: 'border-border-full-opacity',
    pattern: 'border-border(?![-/\\w])',
    hint: 'Prefer border-border/50 or /60 (STYLE.md  - 2).',
  },
  {
    id: 'directional-bare-border',
    pattern: '\\bborder-[tblr]\\b',
    hint: 'A directional border between panels is the wireframe move; use a bg step (STYLE.md  - 2).',
  },
  {
    id: 'naked-overflow-scroll',
    pattern: 'overflow-(auto|scroll|x-auto|y-auto|x-scroll|y-scroll)',
    hint: 'Wrap in <ScrollArea/> unless it is content-level fallback (STYLE.md  - 9).',
  },
]

function countHits(pattern) {
  const res = spawnSync('rg', ['-nP', pattern, 'src', '--glob', '!*.test.*', '--glob', '!*.snap'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (res.status === 1) return { count: 0, sample: [] }
  if (res.status !== 0) {
    console.error(`ripgrep failed for ${pattern}:`, res.stderr)
    process.exit(2)
  }
  const lines = res.stdout.trim().split('\n').filter(Boolean)
  return { count: lines.length, sample: lines.slice(0, 5) }
}

const write = process.argv.includes('--write')

const results = Object.fromEntries(RULES.map((rule) => [rule.id, countHits(rule.pattern)]))

if (write) {
  const snap = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.count]))
  writeFileSync(baselinePath, `${JSON.stringify(snap, null, 2)}\n`)
  console.log(`Wrote baseline to ${baselinePath}:`)
  for (const [id, count] of Object.entries(snap)) console.log(`  ${id}: ${count}`)
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
} catch {
  console.error(`Baseline missing at ${baselinePath}. Run with --write to create.`)
  process.exit(2)
}

let regressed = false
for (const rule of RULES) {
  const current = results[rule.id].count
  const allowed = baseline[rule.id] ?? 0
  const marker = current > allowed ? 'FAIL' : current < allowed ? 'IMPROVED' : 'ok'
  console.log(`[${marker}] ${rule.id}: ${current} (baseline ${allowed})`)
  if (current > allowed) {
    regressed = true
    console.log(`  hint: ${rule.hint}`)
    for (const line of results[rule.id].sample) console.log(`    ${line}`)
  }
}

if (regressed) {
  console.error('\nSTYLE.md regressions detected. Fix the new hits or, if intentional, ratchet the baseline UP with `pnpm --filter @agent-kernel/dashboard lint:style -- --write`.')
  process.exit(1)
}

const improved = RULES.filter((r) => results[r.id].count < (baseline[r.id] ?? 0))
if (improved.length > 0) {
  console.log('\nCounts improved; ratchet the baseline DOWN with `pnpm --filter @agent-kernel/dashboard lint:style -- --write`.')
}
