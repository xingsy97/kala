import { describe, expect, it } from 'vitest'

import { languageForPath, parsePorcelainStatus } from './git-client.js'

describe('parsePorcelainStatus', () => {
  it('parses staged, unstaged, untracked, and renamed entries', () => {
    const parsed = parsePorcelainStatus('## main\0 M src/a.ts\0A  src/b.ts\0?? src/c.ts\0R  src/new.ts\0src/old.ts\0')

    expect(parsed.branch).toBe('main')
    expect(parsed.files).toEqual([
      { path: 'src/a.ts', status: 'modified', staged: false, unstaged: true },
      { path: 'src/b.ts', status: 'added', staged: true, unstaged: false },
      { path: 'src/c.ts', status: 'untracked', staged: false, unstaged: true },
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed', staged: true, unstaged: false },
    ])
  })

  it('marks conflicted entries', () => {
    const parsed = parsePorcelainStatus('## main\0UU src/x.ts\0AA src/y.ts\0DD src/z.ts\0')
    expect(parsed.files.map((f) => f.status)).toEqual(['conflicted', 'conflicted', 'conflicted'])
  })

  it('treats detached HEAD as unnamed branch', () => {
    const parsed = parsePorcelainStatus('## HEAD (no branch)\0')
    expect(parsed.branch).toBeUndefined()
  })

  it('skips malformed short lines', () => {
    const parsed = parsePorcelainStatus('## main\0X\0 M ok.ts\0')
    expect(parsed.files).toEqual([{ path: 'ok.ts', status: 'modified', staged: false, unstaged: true }])
  })
})

describe('languageForPath', () => {
  it('maps common extensions', () => {
    expect(languageForPath('a.ts')).toBe('typescript')
    expect(languageForPath('a.tsx')).toBe('typescript')
    expect(languageForPath('a.js')).toBe('javascript')
    expect(languageForPath('a.py')).toBe('python')
    expect(languageForPath('a.md')).toBe('markdown')
    expect(languageForPath('README')).toBe('plaintext')
  })
})
