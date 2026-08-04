#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const standaloneRoots = ['packages/eval-protocol', 'packages/eval-orchestrator', 'packages/eval-worker', 'packages/eval-sdk', 'packages/eval-analyzer', 'packages/eval-dashboard', 'adapters/agents', 'adapters/benchmarks', 'adapters/environments']
const forbidden = [
  /legacy-v1/iu,
  /legacy-swebench-import/iu,
  /packages\/host\/src\/eval/iu,
  /benchmark-runs/iu,
  /pre-refactor/iu,
  /historical.*(?:import|discover|parse|read)/iu,
]
const exceptions = new Map([
  ['packages/eval-protocol/src/protocol.test.ts', [/legacy Host parser/iu]],
])
const errors = []
for (const base of standaloneRoots) {
  const directory = join(root, base)
  if (!await exists(directory)) continue
  for (const file of await walk(directory)) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(file) || file.includes('/dist/')) continue
    const path = relative(root, file)
    const body = await readFile(file, 'utf8')
    for (const pattern of forbidden) {
      if (!pattern.test(body)) continue
      if ((exceptions.get(path) ?? []).some((allowed) => allowed.test(body))) continue
      errors.push(`${path} matches forbidden clean-cutover pattern ${pattern}`)
    }
  }
}
if (errors.length > 0) { process.stderr.write(errors.map((error) => `- ${error}`).join('\n') + '\n'); process.exit(1) }
process.stdout.write(JSON.stringify({ ok: true, rootsScanned: standaloneRoots.length, policy: 'reject-and-never-discover' }) + '\n')

async function walk(directory) {
  const results = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) results.push(...await walk(path)); else if (entry.isFile()) results.push(path)
  }
  return results
}
async function exists(path) { try { return (await stat(path)).isDirectory() } catch { return false } }
