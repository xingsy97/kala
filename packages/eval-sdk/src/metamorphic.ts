import { canonicalJson, sha256Hex } from '@agent-kernel/eval-protocol'

export type MetamorphicVariantKind = 'path_rename' | 'requirement_rewording' | 'irrelevant_file' | 'function_order' | 'test_output_format' | 'nonsemantic_config'
export type MetamorphicFile = { path: string; content: string; mode?: number }
export type MetamorphicFixture = { prompt: string; files: readonly MetamorphicFile[] }

type ReplaceTransform = { kind: 'requirement_rewording' | 'function_order' | 'test_output_format'; path: string; search: string; replacement: string }
export type MetamorphicTransform =
  | { kind: 'path_rename'; from: string; to: string; references: readonly { path: string; search: string; replacement: string }[] }
  | { kind: 'irrelevant_file'; file: MetamorphicFile }
  | { kind: 'nonsemantic_config'; path: string; key: string; value: string | number | boolean }
  | ReplaceTransform

export type MetamorphicVariant = MetamorphicFixture & {
  manifest: { schemaVersion: 1; generatorVersion: '1.0.0'; variantId: string; kind: MetamorphicVariantKind; seed: number; sourceHash: string; manifestHash: string }
}

export async function generateMetamorphicVariant(input: { fixture: MetamorphicFixture; variantId: string; seed: number; transform: MetamorphicTransform }): Promise<MetamorphicVariant> {
  if (!/^[A-Za-z0-9._:-]+$/u.test(input.variantId)) throw new Error('variantId must be a safe identifier')
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error('seed must be a non-negative safe integer')
  const fixture = normalizeFixture(input.fixture)
  const sourceHash = await sha256Hex(canonicalJson(fixture))
  const transformed = applyTransform(fixture, input.transform)
  const unsigned = { schemaVersion: 1 as const, generatorVersion: '1.0.0' as const, variantId: input.variantId, kind: input.transform.kind, seed: input.seed, sourceHash }
  const manifestHash = await sha256Hex(canonicalJson({ ...unsigned, fixture: transformed }))
  return { ...transformed, manifest: { ...unsigned, manifestHash } }
}

function applyTransform(fixture: MetamorphicFixture, transform: MetamorphicTransform): MetamorphicFixture {
  const files = fixture.files.map((file) => ({ ...file }))
  if (transform.kind === 'path_rename') {
    const from = safePath(transform.from); const to = safePath(transform.to)
    if (files.some((file) => file.path === to)) throw new Error('renamed target already exists: ' + to)
    const source = requiredFile(files, from); source.path = to
    for (const reference of transform.references) replaceExactly(requiredFile(files, safePath(reference.path)), reference.search, reference.replacement)
  } else if (transform.kind === 'irrelevant_file') {
    const file = { ...transform.file, path: safePath(transform.file.path) }
    if (files.some((candidate) => candidate.path === file.path)) throw new Error('irrelevant file already exists: ' + file.path)
    files.push(file)
  } else if (transform.kind === 'nonsemantic_config') {
    const file = requiredFile(files, safePath(transform.path)); const value = JSON.parse(file.content) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('nonsemantic_config requires a JSON object')
    if (transform.key in value) throw new Error('nonsemantic config key already exists: ' + transform.key)
    ;(value as Record<string, unknown>)[transform.key] = transform.value
    file.content = JSON.stringify(value, null, 2) + '\n'
  } else {
    replaceExactly(requiredFile(files, safePath(transform.path)), transform.search, transform.replacement)
  }
  return normalizeFixture({ prompt: fixture.prompt, files })
}

function normalizeFixture(fixture: MetamorphicFixture): MetamorphicFixture {
  if (!fixture.prompt.trim()) throw new Error('fixture prompt cannot be empty')
  const files = fixture.files.map((file) => ({ path: safePath(file.path), content: file.content, ...(file.mode === undefined ? {} : { mode: file.mode }) })).sort((left, right) => left.path.localeCompare(right.path))
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error('fixture file paths must be unique')
  return { prompt: fixture.prompt, files }
}
function safePath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('metamorphic path must be a contained relative path: ' + path)
  return path
}
function requiredFile(files: MetamorphicFile[], path: string): MetamorphicFile { const file = files.find((candidate) => candidate.path === path); if (!file) throw new Error('metamorphic source file not found: ' + path); return file }
function replaceExactly(file: MetamorphicFile, search: string, replacement: string): void { const parts = file.content.split(search); if (!search || parts.length !== 2) throw new Error('metamorphic replacement must match exactly once in ' + file.path); file.content = parts.join(replacement) }
