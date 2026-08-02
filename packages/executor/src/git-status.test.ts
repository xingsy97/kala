import { describe, expect, it } from 'vitest'
import { parseGitPorcelainV2 } from './git-status.js'

describe('parseGitPorcelainV2', () => {
  it('classifies branch, staged, unstaged, untracked, conflicts and submodules', () => {
    const result = parseGitPorcelainV2(`# branch.oid abc\n# branch.head feature/test\n1 M. N... 100644 100644 100644 a b staged.ts\n1 .M N... 100644 100644 100644 a b unstaged.ts\n1 M. S.M. 160000 160000 160000 a b module\n? new.txt\nu UU N... 100644 100644 100644 100644 a b c conflict.ts\n`)
    expect(result).toEqual({ kind: 'repository', branch: 'feature/test', detached: false, staged: 2, unstaged: 1, untracked: 1, conflicted: 1, submodules: 1 })
  })

  it('represents detached head without inventing a branch', () => {
    expect(parseGitPorcelainV2('# branch.oid abc\n# branch.head (detached)\n')).toEqual({ kind: 'repository', detached: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, submodules: 0 })
  })
})
