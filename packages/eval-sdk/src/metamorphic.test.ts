import { describe, expect, it } from 'vitest'
import { generateMetamorphicVariant, type MetamorphicFixture, type MetamorphicTransform } from './metamorphic.js'

const fixture: MetamorphicFixture = { prompt: 'Implement greeting.', files: [{ path: 'src/main.mjs', content: 'export function run() { return "hello" }\n' }, { path: 'tests/main.test.mjs', content: 'import { run } from "../src/main.mjs"\n' }, { path: 'config.json', content: '{"enabled":true}\n' }] }

describe('metamorphic variant generator', () => {
  it.each<[string, MetamorphicTransform]>([
    ['rename', { kind: 'path_rename', from: 'src/main.mjs', to: 'lib/entry.mjs', references: [{ path: 'tests/main.test.mjs', search: '../src/main.mjs', replacement: '../lib/entry.mjs' }] }],
    ['reword', { kind: 'requirement_rewording', path: 'tests/main.test.mjs', search: 'import', replacement: '/* equivalent wording */\nimport' }],
    ['irrelevant', { kind: 'irrelevant_file', file: { path: 'notes/unrelated.md', content: 'unrelated\n' } }],
    ['function-order', { kind: 'function_order', path: 'src/main.mjs', search: 'export function run()', replacement: 'const unused = () => true\nexport function run()' }],
    ['output-format', { kind: 'test_output_format', path: 'tests/main.test.mjs', search: 'import', replacement: 'process.stdout.write("TAP fixture\n")\nimport' }],
    ['config', { kind: 'nonsemantic_config', path: 'config.json', key: 'displayLabel', value: 'variant' }],
  ])('generates deterministic contained %s variants', async (_name, transform) => {
    const first = await generateMetamorphicVariant({ fixture, variantId: 'variant', seed: 7, transform })
    const second = await generateMetamorphicVariant({ fixture, variantId: 'variant', seed: 7, transform })
    expect(first).toEqual(second)
    expect(first.manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.files.every((file) => !file.path.startsWith('/') && !file.path.includes('..'))).toBe(true)
  })

  it('rejects traversal, duplicate targets, and ambiguous replacements', async () => {
    await expect(generateMetamorphicVariant({ fixture, variantId: 'bad', seed: 1, transform: { kind: 'irrelevant_file', file: { path: '../escape', content: '' } } })).rejects.toThrow('contained relative path')
    await expect(generateMetamorphicVariant({ fixture, variantId: 'bad', seed: 1, transform: { kind: 'path_rename', from: 'src/main.mjs', to: 'config.json', references: [] } })).rejects.toThrow('already exists')
    await expect(generateMetamorphicVariant({ fixture, variantId: 'bad', seed: 1, transform: { kind: 'function_order', path: 'src/main.mjs', search: 'missing', replacement: 'x' } })).rejects.toThrow('exactly once')
  })
})
