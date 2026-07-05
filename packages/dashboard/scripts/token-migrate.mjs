#!/usr/bin/env node
// Codemod: replace hardcoded Tailwind slate classes with shadcn semantic tokens.
//
// Runs in --dry mode by default (prints per-file diff summary). Pass --write
// to persist. Scope is packages/dashboard/src/**.
//
// Mapping strategy (shadcn conventions):
//   - Backgrounds: 950/900  -  background/card; 800/700  -  secondary/accent;
//     600  -  muted; 400/300/200/100/50  -  light-side muted/secondary.
//   - Text: 950/900/800/700  -  foreground; 600/500/400/300  -  muted-foreground;
//     200/100/50  -  foreground (dark-side).
//   - Borders / divide / ring: all collapse to border.
//   - The mapping intentionally flattens dark/light-specific slate steps into
//     the same semantic token  -  the CSS var swap in index.css already handles
//     dark vs light.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../src/', import.meta.url).pathname
const WRITE = process.argv.includes('--write')
const ONLY_IDX = process.argv.indexOf('--only')
const ONLY = ONLY_IDX >= 0 ? process.argv[ONLY_IDX + 1] : null

const REPLACEMENTS = [
  // Backgrounds (order matters: 950 before 900 before 950-suffixed variants)
  ['bg-slate-950', 'bg-background'],
  ['bg-slate-900', 'bg-card'],
  ['bg-slate-800', 'bg-secondary'],
  ['bg-slate-700', 'bg-secondary'],
  ['bg-slate-600', 'bg-muted'],
  ['bg-slate-400', 'bg-muted'],
  ['bg-slate-300', 'bg-muted'],
  ['bg-slate-200', 'bg-muted'],
  ['bg-slate-100', 'bg-secondary'],
  ['bg-slate-50', 'bg-muted'],

  // Text
  ['text-slate-950', 'text-foreground'],
  ['text-slate-900', 'text-foreground'],
  ['text-slate-800', 'text-foreground'],
  ['text-slate-700', 'text-foreground'],
  ['text-slate-600', 'text-muted-foreground'],
  ['text-slate-500', 'text-muted-foreground'],
  ['text-slate-400', 'text-muted-foreground'],
  ['text-slate-300', 'text-muted-foreground'],
  ['text-slate-200', 'text-foreground'],
  ['text-slate-100', 'text-foreground'],
  ['text-slate-50', 'text-foreground'],

  // Borders + divide
  ['border-slate-900', 'border-border'],
  ['border-slate-800', 'border-border'],
  ['border-slate-700', 'border-border'],
  ['border-slate-600', 'border-border'],
  ['border-slate-300', 'border-border'],
  ['border-slate-200', 'border-border'],
  ['divide-slate-900', 'divide-border'],
  ['divide-slate-100', 'divide-border'],
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (/\.(tsx?|css)$/.test(entry)) yield p
  }
}

const changed = []
for (const file of walk(ROOT)) {
  if (ONLY && !file.replace(ROOT, '').startsWith(ONLY)) continue
  const src = readFileSync(file, 'utf8')
  let out = src
  const perFile = {}
  for (const [from, to] of REPLACEMENTS) {
    // Word boundary via lookaround so `bg-slate-900/50` still matches
    // (the alpha modifier is preserved by only replacing the token prefix).
    const re = new RegExp(`\\b${from.replace(/[-\\/]/g, '\\$&')}\\b`, 'g')
    const before = out
    out = out.replace(re, to)
    const hits = (before.match(re) ?? []).length
    if (hits > 0) perFile[from] = (perFile[from] ?? 0) + hits
  }
  if (out !== src) {
    changed.push({ file: file.replace(ROOT, ''), perFile })
    if (WRITE) writeFileSync(file, out, 'utf8')
  }
}

console.log(`${WRITE ? 'wrote' : 'would rewrite'} ${changed.length} files`)
for (const { file, perFile } of changed) {
  const entries = Object.entries(perFile)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} - ${v}`)
    .join(', ')
  console.log(`  ${file}  (${entries})`)
}
