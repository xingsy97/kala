#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const ACCEPTANCE_KEYS = Object.freeze([
  'architecture',
  'category',
  'checks',
  'image',
  'imageId',
  'ok',
  'revision',
  'tag',
  'version',
])

export const ACCEPTANCE_CHECK_KEYS = Object.freeze([
  'capabilities',
  'dashboard',
  'loopbackPublish',
  'nonRoot',
  'persistentVolume',
  'sessionPersistence',
])

export function verifyPortableAcceptanceEvidence(evidence, { image, tag, revision }) {
  assert.deepEqual(Object.keys(evidence).sort(), [...ACCEPTANCE_KEYS].sort(), 'acceptance evidence contains an unexpected or privacy-sensitive field')
  assert.equal(evidence.ok, true)
  assert.equal(evidence.category, 'portable-container')
  assert.equal(evidence.image, image)
  assert.match(evidence.image, /^ghcr\.io\/[a-z0-9][a-z0-9./_-]+@sha256:[0-9a-f]{64}$/u)
  assert.match(evidence.imageId, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(evidence.architecture, 'amd64')
  assert.equal(evidence.tag, tag)
  assert.equal(evidence.version, tag.slice(1))
  assert.equal(evidence.revision, revision)
  assert.match(evidence.revision, /^[0-9a-f]{40}$/u)
  assert.deepEqual(Object.keys(evidence.checks).sort(), [...ACCEPTANCE_CHECK_KEYS].sort(), 'acceptance checks contain an unexpected field')
  for (const key of ACCEPTANCE_CHECK_KEYS) assert.equal(evidence.checks[key], true, `${key} acceptance check did not pass`)
  return evidence
}

function main() {
  const evidence = JSON.parse(readFileSync(resolve(required('--acceptance')), 'utf8'))
  verifyPortableAcceptanceEvidence(evidence, {
    image: required('--image'),
    tag: required('--tag'),
    revision: required('--revision'),
  })
  process.stdout.write(JSON.stringify({ ok: true, privacySafe: true }) + '\n')
}

function required(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
