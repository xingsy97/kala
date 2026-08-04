#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const value = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const inputArg = value('--input')
const outputArg = value('--output')
if (!inputArg || !outputArg) fail('usage: record-evidence-revision.mjs --input <json> --output <json> [--supersedes <path,...>]')

const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
if (status.status !== 0) fail(status.stderr.trim() || 'unable to inspect git status')
if (status.stdout.trim()) fail('refusing to record current evidence from a dirty tree')
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
if (revision.status !== 0 || !/^[a-f0-9]{40}\n?$/u.test(revision.stdout)) fail('unable to resolve full HEAD revision')

const input = resolve(root, inputArg)
const output = resolve(root, outputArg)
if (existsSync(output)) fail(`refusing to overwrite immutable evidence: ${relative(root, output)}`)
let content
try { content = JSON.parse(readFileSync(input, 'utf8')) } catch { fail(`input is not valid JSON: ${inputArg}`) }
if (!content || typeof content !== 'object' || Array.isArray(content)) fail('evidence input must be a JSON object')

const supersedes = (value('--supersedes') ?? '').split(',').map((item) => item.trim()).filter(Boolean)
for (const path of supersedes) {
  if (!path.startsWith('docs/evidence/') || !existsSync(resolve(root, path))) fail(`superseded evidence does not exist: ${path}`)
}
const record = {
  ...content,
  status: 'current',
  sourceRevision: revision.stdout.trim(),
  generatedAt: new Date().toISOString(),
  supersedes,
  generator: `node scripts/evaluation/record-evidence-revision.mjs --input ${inputArg} --output ${outputArg}`,
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })

function fail(message) {
  console.error(message)
  process.exit(1)
}
