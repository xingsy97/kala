#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { requiredDetectorValidationCorpus, requiredDetectorValidationManifest, validateDetector, type RequiredDetectorId } from '../src/index.js'

const generatedAt = option('--generated-at') ?? new Date().toISOString()
const output = option('--output')
const detectorIds: RequiredDetectorId[] = ['instruction-drift', 'context-forgetting', 'test-gaming', 'tool-recovery', 'planning-execution']
const corpus = await requiredDetectorValidationCorpus()
const manifest = await requiredDetectorValidationManifest(corpus)
const reports = detectorIds.map((detectorId) => validateDetector(detectorId, corpus, generatedAt, manifest.corpusId, manifest.corpusVersion))
const document = { schemaVersion: 1, corpusId: manifest.corpusId, corpusVersion: manifest.corpusVersion, generatedAt, cases: corpus.length, manifest, reports }
if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 }) }
process.stdout.write(JSON.stringify(document) + '\n')

function option(name: string): string | undefined {
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) return process.argv[index + 1]
    if (process.argv[index]?.startsWith(name + '=')) return process.argv[index]!.slice(name.length + 1)
  }
  return undefined
}
