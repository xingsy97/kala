#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { validateRcEvidence } from './rc-evidence.mjs'

const evidencePath = resolve(required('--evidence'))
const archivePath = resolve(required('--archive'))
const tag = required('--tag')
const revision = required('--revision')
const evidence = validateRcEvidence(JSON.parse(readFileSync(evidencePath, 'utf8')), { tag, revision })

if (evidence.category !== 'private-cloud' || evidence.target !== 'linux-x64-compose-fresh') throw new Error('fresh Private Cloud evidence target is required')
if (evidence.artifact.name !== basename(archivePath)) throw new Error('fresh Private Cloud evidence artifact name mismatch')
const archiveSha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
if (evidence.artifact.sha256 !== archiveSha256) throw new Error('fresh Private Cloud evidence archive digest mismatch')

process.stdout.write(JSON.stringify({ ok: true, tag, revision, target: evidence.target, artifact: evidence.artifact }) + '\n')

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function required(name) { const value = option(name); if (!value) throw new Error('missing ' + name); return value }
