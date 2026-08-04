#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(new URL('../..', import.meta.url).pathname)
const directory = await mkdtemp(join(tmpdir(), 'eval-protocol-browser-'))
try {
  const entry = join(directory, 'entry.mjs')
  const output = join(directory, 'bundle.mjs')
  await writeFile(entry, `import { EvaluationRunSpecSchema, formatEvaluatedSliceLabel } from ${JSON.stringify(join(root, 'packages/eval-protocol/dist/index.js'))}; globalThis.__evalProtocol = { EvaluationRunSpecSchema, formatEvaluatedSliceLabel };\n`)
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'browser', format: 'esm', target: ['es2022'], logLevel: 'silent' })
  const bundle = await readFile(output, 'utf8')
  if (/node:(?:fs|path|crypto|http)/u.test(bundle)) throw new Error('browser bundle contains a Node builtin import')
  process.stdout.write(JSON.stringify({ ok: true, bytes: Buffer.byteLength(bundle), nodeBuiltinImports: 0 }) + '\n')
} finally {
  await rm(directory, { recursive: true, force: true })
}
