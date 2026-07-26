import { describe, expect, it } from 'vitest'

import { parseBenchmarkCli } from './benchmark-cli.js'

describe('benchmark CLI', () => {
  it('parses backend discovery', () => {
    expect(parseBenchmarkCli(['benchmark', 'backends'])).toEqual({ kind: 'backends' })
  })

  it('parses a shared run spec', () => {
    expect(parseBenchmarkCli(['benchmark', 'run', '--config', 'run.json', '--root-dir', '/tmp/runs'])).toEqual({
      kind: 'run', configPath: 'run.json', rootDir: '/tmp/runs',
    })
  })

  it('parses read-only legacy import', () => {
    expect(parseBenchmarkCli(['benchmark', 'import-legacy-swebench', '--source-dir', '/old', '--root-dir', '/new', '--import-id', 'baseline'])).toEqual({
      kind: 'import-legacy-swebench', sourceDir: '/old', rootDir: '/new', importId: 'baseline',
    })
  })
})

