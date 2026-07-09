import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runProgramBenchCompileProbe } from './programbench-compile.js'

describe('ProgramBench compile probe', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'programbench-compile-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('passes when compile.sh builds executable successfully', async () => {
    await writeFile(join(dir, 'main.c'), 'int main(void) { return 0; }\n')
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc main.c -o executable\n')
    await chmod(join(dir, 'compile.sh'), 0o755)

    const probe = await runProgramBenchCompileProbe({ workspaceRoot: dir, timeoutMs: 10_000 })

    expect(probe.ok).toBe(true)
    expect(probe.status).toBe('passed')
    expect(probe.reason_codes).toEqual([])
    expect(probe.exit_code).toBe(0)
  })

  it('records compiler stderr when compile.sh fails', async () => {
    await writeFile(join(dir, 'main.c'), 'int main(void) { return missing_symbol; }\n')
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc main.c -o executable\n')
    await chmod(join(dir, 'compile.sh'), 0o755)

    const probe = await runProgramBenchCompileProbe({ workspaceRoot: dir, timeoutMs: 10_000 })

    expect(probe.ok).toBe(false)
    expect(probe.status).toBe('failed')
    expect(probe.reason_codes).toEqual(['compile_failed'])
    expect(probe.stderr).toContain('missing_symbol')
  })

  it('skips when compile.sh is missing', async () => {
    await writeFile(join(dir, 'main.c'), 'int main(void) { return 0; }\n')

    const probe = await runProgramBenchCompileProbe({ workspaceRoot: dir, timeoutMs: 10_000 })

    expect(probe.ok).toBe(false)
    expect(probe.status).toBe('skipped')
    expect(probe.reason_codes).toEqual(['compile_sh_missing'])
  })

  it('times out bounded compile commands', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\nsleep 5\n')
    await chmod(join(dir, 'compile.sh'), 0o755)

    const probe = await runProgramBenchCompileProbe({ workspaceRoot: dir, timeoutMs: 100 })

    expect(probe.ok).toBe(false)
    expect(probe.status).toBe('timeout')
    expect(probe.reason_codes).toEqual(['compile_timeout'])
  })
})
