#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const indexPath = resolve(required('--index'))
const assetPath = resolve(required('--asset'))
const assetName = basename(assetPath)
const manifestPath = option('--manifest') ? resolve(option('--manifest')) : undefined
const matches = readFileSync(indexPath, 'utf8').split(/\r?\n/u).map((line) => line.match(/^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u)).filter((match) => match?.[2] === assetName)
if (matches.length !== 1) throw new Error('checksum index must contain exactly one valid entry for ' + assetName)
if (dirname(assetPath) !== dirname(indexPath)) throw new Error('asset and checksum index must share one directory')
const actual = createHash('sha256').update(readFileSync(assetPath)).digest('hex')
if (actual !== matches[0][1]) throw new Error('checksum mismatch for ' + assetName)
if (manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.assets) || manifest.assets.filter((name) => name === assetName).length !== 1) throw new Error('release manifest must contain the asset exactly once')
  const revision = option('--revision')
  if (revision && manifest.source?.revision !== revision) throw new Error('release manifest revision mismatch')
}
process.stdout.write(JSON.stringify({ ok: true, asset: assetName }) + '\n')

function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error('missing ' + name); return process.argv[index + 1] }
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
