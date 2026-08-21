#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const directory = resolve(process.argv[2] ?? 'release/private-cloud')
const manifest = json('manifest.json')
const lock = json('image-lock.json')
if (manifest.schemaVersion !== 1 || manifest.product !== 'agent-runlab-private-cloud' || !/^[0-9a-f]{40}$/u.test(manifest.revision)) fail('invalid bundle manifest identity')
if (lock.schemaVersion !== 1 || lock.product !== manifest.product || lock.version !== manifest.version || lock.revision !== manifest.revision) fail('image lock identity does not match manifest')
for (const [component, image] of Object.entries(lock.images ?? {})) if (!['runtime', 'ingress', 'dashboard'].includes(component) || !immutable(image)) fail(`invalid ${component} image digest`)
if (Object.keys(lock.images ?? {}).length !== 3) fail('image lock must contain exactly Runtime, Ingress, and Dashboard')
for (const [name, expected] of Object.entries(manifest.files ?? {})) {
  if (name.includes('/') || name === 'manifest.json') fail(`invalid manifest path ${name}`)
  const body = readFileSync(join(directory, name)); const actual = { bytes: statSync(join(directory, name)).size, sha256: createHash('sha256').update(body).digest('hex') }
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) fail(`bundle integrity failed for ${name}`)
}
const actualNames = readdirSync(directory).sort()
const expectedNames = Object.keys(manifest.files).concat('manifest.json').sort()
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) fail('bundle file set does not exactly match manifest')
const compose = readFileSync(join(directory, 'compose.yaml'), 'utf8')
if (/^\s+build:/mu.test(compose)) fail('production Compose contains build')
const literalImages = [...compose.matchAll(/^\s+image:\s+([^$\s][^\s]*)/gmu)].map((match) => match[1])
for (const image of literalImages) if (!immutable(image)) fail(`production image is not digest pinned: ${image}`)
if (!compose.includes('RUNLAB_RUNTIME_IMAGE') || !compose.includes('RUNLAB_INGRESS_IMAGE') || !compose.includes('RUNLAB_DASHBOARD_IMAGE')) fail('production Compose does not consume the component image lock')
if (actualNames.includes('compose.dev.yaml')) fail('source-build override must not ship')
const operators = actualNames.filter((name) => name === 'runlab-private-cloud' || name === 'runlab-private-cloud.mjs')
if (operators.length !== 1) fail('bundle must contain exactly one operator executable')
accessSync(join(directory, operators[0]), constants.X_OK)
process.stdout.write(`${JSON.stringify({ ok: true, version: manifest.version, revision: manifest.revision, images: lock.images, files: actualNames.length })}\n`)

function json(name) { try { return JSON.parse(readFileSync(join(directory, name), 'utf8')) } catch { fail(`invalid ${name}`) } }
function immutable(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u.test(value) }
function fail(message) { process.stderr.write(`FAIL ${message}\n`); process.exit(1) }
