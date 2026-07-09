import { access, constants, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  compareProgramBenchSubmissionContracts,
  inspectProgramBenchSubmissionContract,
  maybeNormalizeProgramBenchCompileShExecutable,
  type ProgramBenchSubmissionContractNormalization,
} from './programbench-contract.js'

describe('ProgramBench submission contract', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'programbench-contract-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('does not normalize when compile.sh is missing', async () => {
    await writeFile(join(dir, 'main.c'), 'int main(void) { return 0; }\n')

    const contract = await inspectProgramBenchSubmissionContract(dir)
    const normalization = await maybeNormalizeProgramBenchCompileShExecutable(dir, contract, true)

    expect(normalization).toEqual({ applied: false, reason: 'compile.sh is missing' })
    expect(contract.ok).toBe(false)
    expect(contract.reason_codes).toContain('missing_compile_sh')
    expect(contract.source_files).toEqual(['main.c'])
  })

  it('chmods an existing compile.sh without changing source requirements', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc main.c -o executable\n', { mode: 0o644 })
    await writeFile(join(dir, 'main.c'), 'int main(void) { return 0; }\n')

    const before = await inspectProgramBenchSubmissionContract(dir)
    expect(before.ok).toBe(false)
    expect(before.reason_codes).toEqual(['compile_sh_not_executable'])

    const normalization = await maybeNormalizeProgramBenchCompileShExecutable(dir, before, true)
    expect(normalization.applied).toBe(true)

    await expect(access(join(dir, 'compile.sh'), constants.X_OK)).resolves.toBeUndefined()
    const normalizations: ProgramBenchSubmissionContractNormalization[] = [
      { kind: 'chmod_compile_sh_executable', ...normalization },
    ]
    const after = await inspectProgramBenchSubmissionContract(dir, normalizations)
    expect(after.ok).toBe(true)
    expect(after.reason_codes).toEqual([])
    expect(after.source_files).toEqual(['main.c'])
    expect(after.runner_normalizations).toEqual(normalizations)
  })

  it('leaves an already executable compile.sh unchanged', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc main.c -o executable\n', { mode: 0o755 })
    await writeFile(join(dir, 'main.c'), 'int main(void) { return 0; }\n')

    const contract = await inspectProgramBenchSubmissionContract(dir)
    const normalization = await maybeNormalizeProgramBenchCompileShExecutable(dir, contract, true)

    expect(contract.ok).toBe(true)
    expect(normalization).toEqual({ applied: false, reason: 'compile.sh is already executable' })
  })

  it('does not count compile.sh itself as a source implementation file', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc main.c -o executable\n', { mode: 0o755 })

    const contract = await inspectProgramBenchSubmissionContract(dir)

    expect(contract.ok).toBe(false)
    expect(contract.source_file_count).toBe(0)
    expect(contract.source_files).toEqual([])
    expect(contract.reason_codes).toContain('missing_source_files')
  })

  it('records header files without treating header-only workspaces as implementation-complete', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc main.c -o executable\n', { mode: 0o755 })
    await writeFile(join(dir, 'kseq.h'), '#define KSEQ_INIT(type_t, read)\n')

    const contract = await inspectProgramBenchSubmissionContract(dir)

    expect(contract.ok).toBe(false)
    expect(contract.source_files).toEqual(['kseq.h'])
    expect(contract.implementation_files).toEqual([])
    expect(contract.checks.source_files_present).toBe(false)
    expect(contract.checks.implementation_files_present).toBe(false)
    expect(contract.reason_codes).toContain('missing_source_files')
  })

  it('treats buildable implementation files as the source contract signal', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc seqtk.c -o executable\n', { mode: 0o755 })
    await writeFile(join(dir, 'kseq.h'), '#define KSEQ_INIT(type_t, read)\n')
    await writeFile(join(dir, 'seqtk.c'), '#include "kseq.h"\nint main(void) { return 0; }\n')

    const contract = await inspectProgramBenchSubmissionContract(dir)

    expect(contract.ok).toBe(true)
    expect(contract.source_files).toEqual(['kseq.h', 'seqtk.c'])
    expect(contract.implementation_files).toEqual(['seqtk.c'])
    expect(contract.checks.source_files_present).toBe(true)
    expect(contract.checks.implementation_files_present).toBe(true)
  })

  it('does not treat unchanged runner bootstrap scaffold as agent-authored implementation', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/usr/bin/env bash\nset -euo pipefail\ngcc -O2 -o executable main.c -lz -lm\n', { mode: 0o755 })
    await writeFile(join(dir, 'main.c'), 'int main(int argc, char **argv) { (void)argc; (void)argv; return 0; }\n')

    const contract = await inspectProgramBenchSubmissionContract(dir, [{
      kind: 'runner_bootstrap_submission_skeleton',
      applied: true,
      reason: 'test bootstrap',
      files: ['compile.sh', 'main.c'],
    }])

    expect(contract.ok).toBe(false)
    expect(contract.checks.implementation_files_present).toBe(true)
    expect(contract.checks.implementation_written_through_after_bootstrap).toBe(false)
    expect(contract.reason_codes).toContain('bootstrap_scaffold_not_replaced')
  })

  it('accepts bootstrap workspaces only after the implementation file changes', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/usr/bin/env bash\nset -euo pipefail\ngcc -O2 -o executable main.c -lz -lm\n', { mode: 0o755 })
    await writeFile(join(dir, 'main.c'), '#include <stdio.h>\nint main(void) { puts("usage"); return 1; }\n')

    const contract = await inspectProgramBenchSubmissionContract(dir, [{
      kind: 'runner_bootstrap_submission_skeleton',
      applied: true,
      reason: 'test bootstrap',
      files: ['compile.sh', 'main.c'],
    }])

    expect(contract.ok).toBe(true)
    expect(contract.checks.implementation_written_through_after_bootstrap).toBe(true)
    expect(contract.reason_codes).not.toContain('bootstrap_scaffold_not_replaced')
  })

  it('classifies contract progress when required files appear', async () => {
    const before = await inspectProgramBenchSubmissionContract(dir)
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc main.c -o executable\n', { mode: 0o755 })
    await writeFile(join(dir, 'main.c'), 'int main(void) { return 0; }\n')
    const after = await inspectProgramBenchSubmissionContract(dir)

    expect(compareProgramBenchSubmissionContracts(before, after)).toMatchObject({
      classification: 'contract_satisfied',
      improved: true,
      resolved_reason_codes: ['missing_compile_sh', 'missing_source_files'],
      source_file_delta: 1,
      implementation_file_delta: 1,
      compile_sh_created: true,
      compile_sh_became_executable: true,
    })
  })

  it('does not classify newly added header-only files as artifact-contract progress', async () => {
    const before = await inspectProgramBenchSubmissionContract(dir)
    await writeFile(join(dir, 'kseq.h'), '#define KSEQ_INIT(type_t, read)\n')
    const after = await inspectProgramBenchSubmissionContract(dir)

    expect(compareProgramBenchSubmissionContracts(before, after)).toMatchObject({
      classification: 'no_progress',
      improved: false,
      resolved_reason_codes: [],
      new_reason_codes: [],
      source_file_delta: 1,
      implementation_file_delta: 0,
      compile_sh_created: false,
      compile_sh_became_executable: false,
    })
  })

  it('classifies no progress when the contract is unchanged', async () => {
    await writeFile(join(dir, 'README.md'), 'notes\n')
    const before = await inspectProgramBenchSubmissionContract(dir)
    await writeFile(join(dir, 'notes.txt'), 'more notes\n')
    const after = await inspectProgramBenchSubmissionContract(dir)

    expect(compareProgramBenchSubmissionContracts(before, after)).toMatchObject({
      classification: 'no_progress',
      improved: false,
      resolved_reason_codes: [],
      new_reason_codes: [],
      source_file_delta: 0,
      implementation_file_delta: 0,
      compile_sh_created: false,
      compile_sh_became_executable: false,
    })
  })

  it('classifies regression when a required artifact disappears', async () => {
    await writeFile(join(dir, 'compile.sh'), '#!/bin/sh\ncc main.c -o executable\n', { mode: 0o755 })
    await writeFile(join(dir, 'main.c'), 'int main(void) { return 0; }\n')
    const before = await inspectProgramBenchSubmissionContract(dir)
    await rm(join(dir, 'compile.sh'))
    const after = await inspectProgramBenchSubmissionContract(dir)

    expect(compareProgramBenchSubmissionContracts(before, after)).toMatchObject({
      classification: 'regression',
      improved: false,
      new_reason_codes: ['missing_compile_sh'],
      source_file_delta: 0,
      implementation_file_delta: 0,
      compile_sh_created: false,
      compile_sh_became_executable: false,
    })
  })
})
