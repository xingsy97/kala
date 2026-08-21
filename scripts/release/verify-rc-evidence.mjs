#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { collectRcEvidence, verifyRcEvidenceSet } from './rc-evidence.mjs'

const input = resolve(required('--input'))
const tag = required('--tag')
const revision = required('--revision')
const records = collectRcEvidence(input)
const evidence = verifyRcEvidenceSet(records, { tag, revision })
const aggregate = {
  schemaVersion: 1, product: 'agent-runlab', tag, version: tag.slice(1), revision, ok: true,
  evidence: evidence.map((entry) => ({ category: entry.category, target: entry.target, artifact: entry.artifact, generatedAt: entry.generatedAt })),
  generatedAt: new Date().toISOString(),
}
const outputArg = option('--output')
if (outputArg) {
  const output = resolve(outputArg)
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  const temp = output + '.tmp-' + process.pid + '-' + randomUUID()
  writeFileSync(temp, JSON.stringify(aggregate, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  renameSync(temp, output)
}
process.stdout.write(JSON.stringify({ ok: true, tag, revision, records: evidence.length, output: outputArg ? basename(outputArg) : null }) + '\n')

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function required(name) { const value = option(name); if (!value) throw new Error('missing ' + name); return value }
