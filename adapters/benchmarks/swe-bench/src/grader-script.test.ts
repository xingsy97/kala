import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('SWE-Bench grader process policy', () => {
  it('allows the isolated Agent-owned workspace without changing global Git config', async () => {
    const source = await readFile(resolve(process.cwd(), 'bin/swe-bench-grade.ts'), 'utf8')

    expect(source).toContain("GIT_CONFIG_GLOBAL: temporaryGitConfig")
    expect(source).toContain("'[safe]\\n\\tdirectory = /workspace\\n'")
    expect(source).toContain('await unlink(temporaryGitConfig)')
    expect(source).not.toMatch(/git config --global/iu)
  })
})
