#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { generateMetamorphicVariant } from '../../packages/eval-sdk/dist/index.js'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const fixtureRoot = resolve(root, 'task-packs/metamorphic-v1/greeting-contract')
const fixture = { prompt: await readFile(join(fixtureRoot, 'TASK.md'), 'utf8'), files: await readFixtureFiles(fixtureRoot) }
const transforms = [
  { id: 'path-rename', transform: { kind: 'path_rename', from: 'src/cli.mjs', to: 'app/entry.mjs', references: [{ path: 'tests/contract.test.mjs', search: '../src/cli.mjs', replacement: '../app/entry.mjs' }, { path: 'app/entry.mjs', search: './format.mjs', replacement: '../src/format.mjs' }] } },
  { id: 'requirement-rewording', transform: { kind: 'requirement_rewording', path: 'TASK.md', search: '# Implement a greeting command', replacement: '# Build an equivalent salutation CLI' } },
  { id: 'irrelevant-file', transform: { kind: 'irrelevant_file', file: { path: 'docs/unrelated-release-notes.md', content: '# Unrelated notes\n\nNo runtime behavior is defined here.\n' } } },
  { id: 'function-order', transform: { kind: 'function_order', path: 'src/format.mjs', search: 'export function format(prefix, name) {\n  return `${prefix} ${name}`\n}\n', replacement: 'function normalizeName(name) { return name }\n\nexport function format(prefix, name) {\n  return `${prefix} ${normalizeName(name)}`\n}\n' } },
  { id: 'test-output-format', transform: { kind: 'test_output_format', path: 'tests/contract.test.mjs', search: "test('accepts arbitrary names and rejects invalid arity', () => {", replacement: "test('same contract with reformatted diagnostics', () => {" } },
  { id: 'nonsemantic-config', transform: { kind: 'nonsemantic_config', path: 'config/runtime.json', key: 'displayLabel', value: 'synthetic-variant' } },
]

const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-metamorphic-'))
const baseVerifier = await verifyFixture(fixture, join(temporary, 'base'))
if (!baseVerifier.passed) throw new Error('base metamorphic fixture failed its native contract')
const variants = []
for (const [index, definition] of transforms.entries()) {
  const variant = await generateMetamorphicVariant({ fixture, variantId: definition.id, seed: 20260803 + index, transform: definition.transform })
  const verifier = await verifyFixture(variant, join(temporary, definition.id))
  if (!verifier.passed || verifier.signature !== baseVerifier.signature) throw new Error('semantic-equivalence failed for ' + definition.id)
  variants.push({ variantId: definition.id, kind: variant.manifest.kind, seed: variant.manifest.seed, manifestHash: variant.manifest.manifestHash, verifier })
}
if (new Set(variants.map((variant) => variant.manifestHash)).size !== variants.length) throw new Error('metamorphic variants do not have distinct manifests')

const brittle = await brittleCandidateSensitivity(fixture, temporary)
if (!brittle.basePassed || brittle.variantPassed) throw new Error('path-memorization sensitivity control did not distinguish the path-renamed variant')
const semanticMutation = await semanticMutationSensitivity(fixture, temporary)
if (!semanticMutation.basePassed || semanticMutation.mutantPassed) throw new Error('semantic mutation sensitivity control did not distinguish a changed prefix')

const sourcePaths = ['packages/eval-sdk/src/metamorphic.ts', 'packages/eval-sdk/src/metamorphic.test.ts', 'scripts/evaluation/verify-metamorphic-variants.mjs', ...fixture.files.map((file) => 'task-packs/metamorphic-v1/greeting-contract/' + file.path)]
const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'deterministic public metamorphic task variants with native semantic-equivalence and memorization/semantic-mutation sensitivity; no historical Session input', generatorVersion: '1.0.0', sourceRevision: (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim(), sourceFiles, baseVerifier, variants, sensitivity: { brittlePathCandidate: brittle, semanticMutation } }
const output = resolve(root, option('--output') ?? 'docs/evidence/evaluation/metamorphic-variants-acceptance-20260803.json')
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
process.stdout.write(JSON.stringify({ ok: true, equivalentVariants: variants.length, sensitivityControls: 2, output }) + '\n')

async function verifyFixture(value, directory) {
  await materialize(value.files, directory)
  const result = await runFile(process.execPath, ['--test', 'tests/contract.test.mjs'], { cwd: directory, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }).catch((error) => error)
  const passed = result.code === undefined && result.signal === undefined
  const samples = ['Ada', 'two words', 'Ω']
  const outputs = []
  for (const name of samples) { const run = await runFile(process.execPath, [entryPath(value.files), name], { cwd: directory, encoding: 'utf8', timeout: 10_000 }).catch((error) => error); outputs.push({ name, status: run.code ?? 0, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }) }
  const invalid = await runFile(process.execPath, [entryPath(value.files)], { cwd: directory, encoding: 'utf8', timeout: 10_000 }).catch((error) => error)
  const contract = outputs.every((item) => item.status === 0 && item.stdout === 'hello ' + item.name + '\n') && (invalid.code ?? 0) !== 0 && /usage:/u.test(invalid.stderr ?? '')
  return { passed: passed && contract, signature: sha256(Buffer.from(JSON.stringify({ outputs, invalidStatus: invalid.code ?? 0, invalidUsage: /usage:/u.test(invalid.stderr ?? '') }))), samples: outputs.length, invalidArityRejected: (invalid.code ?? 0) !== 0 }
}
async function brittleCandidateSensitivity(value, directory) {
  const base = join(directory, 'brittle-base'); await materialize(value.files, base); await writeFile(join(base, 'candidate-check.mjs'), "import { access } from 'node:fs/promises'; await access('src/cli.mjs')\n")
  const basePassed = await exitsZero(process.execPath, ['candidate-check.mjs'], base)
  const renamed = await generateMetamorphicVariant({ fixture: value, variantId: 'brittle-path-control', seed: 99, transform: transforms[0].transform })
  const variant = join(directory, 'brittle-variant'); await materialize(renamed.files, variant); await writeFile(join(variant, 'candidate-check.mjs'), "import { access } from 'node:fs/promises'; await access('src/cli.mjs')\n")
  const variantPassed = await exitsZero(process.execPath, ['candidate-check.mjs'], variant)
  return { basePassed, variantPassed, detectedBrittlePathAssumption: basePassed && !variantPassed }
}
async function semanticMutationSensitivity(value, directory) {
  const base = await verifyFixture(value, join(directory, 'semantic-base'))
  const files = value.files.map((file) => file.path === 'config/runtime.json' ? { ...file, content: file.content.replace('hello', 'welcome') } : file)
  const mutant = await verifyFixture({ ...value, files }, join(directory, 'semantic-mutant'))
  return { basePassed: base.passed, mutantPassed: mutant.passed, detectedSemanticChange: base.passed && !mutant.passed }
}
async function readFixtureFiles(directory) { const output = []; async function walk(current) { for (const entry of await readdir(current, { withFileTypes: true })) { const path = join(current, entry.name); if (entry.isDirectory()) await walk(path); else output.push({ path: relative(directory, path), content: await readFile(path, 'utf8') }) } } await walk(directory); return output.sort((left, right) => left.path.localeCompare(right.path)) }
async function materialize(files, directory) { for (const file of files) { const path = join(directory, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, file.content, { encoding: 'utf8', mode: file.mode ?? 0o600 }) } }
function entryPath(files) { return files.some((file) => file.path === 'app/entry.mjs') ? 'app/entry.mjs' : 'src/cli.mjs' }
async function exitsZero(binary, args, cwd) { try { await runFile(binary, args, { cwd, encoding: 'utf8', timeout: 10_000 }); return true } catch { return false } }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
