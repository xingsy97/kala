import { access, chmod, constants, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type ProgramBenchSubmissionContract = {
  schema_version: 1
  ok: boolean
  checks: {
    compile_sh_exists: boolean
    compile_sh_executable: boolean
    source_files_present: boolean
    implementation_files_present: boolean
    implementation_written_through_after_bootstrap: boolean
    reference_executable_present_before_packaging: boolean
  }
  source_file_count: number
  source_files: string[]
  implementation_file_count: number
  implementation_files: string[]
  reason_codes: string[]
  required_actions: string[]
  runner_normalizations?: readonly ProgramBenchSubmissionContractNormalization[]
}

export type ProgramBenchSubmissionContractNormalization = {
  kind: 'chmod_compile_sh_executable' | 'runner_bootstrap_submission_skeleton'
  applied: boolean
  reason: string
  files?: readonly string[]
}

export type ProgramBenchSubmissionContractProgress = {
  classification: 'contract_satisfied' | 'progress' | 'no_progress' | 'regression'
  improved: boolean
  resolved_reason_codes: readonly string[]
  new_reason_codes: readonly string[]
  remaining_reason_codes: readonly string[]
  source_file_delta: number
  implementation_file_delta: number
  compile_sh_created: boolean
  compile_sh_became_executable: boolean
}

export async function inspectProgramBenchSubmissionContract(
  workspaceRoot: string,
  runnerNormalizations: readonly ProgramBenchSubmissionContractNormalization[] = [],
): Promise<ProgramBenchSubmissionContract> {
  const compilePath = join(workspaceRoot, 'compile.sh')
  const compileExists = existsSync(compilePath)
  let compileExecutable = false
  if (compileExists) {
    compileExecutable = await access(compilePath, constants.X_OK).then(() => true, () => false)
  }
  const sourceFiles = await collectProgramBenchSourceFiles(workspaceRoot)
  const relativeSourceFiles = sourceFiles
    .map((file) => relative(workspaceRoot, file).replaceAll(sep, '/'))
    .sort()
  const relativeImplementationFiles = relativeSourceFiles
    .filter(isProgramBenchImplementationFile)
    .sort()
  const implementationWrittenThrough = await implementationWrittenThroughAfterBootstrap(
    workspaceRoot,
    runnerNormalizations,
    relativeImplementationFiles,
  )
  const referenceExecutable = existsSync(join(workspaceRoot, 'executable'))
  const reasonCodes: string[] = []
  const requiredActions: string[] = []
  if (!compileExists) {
    reasonCodes.push('missing_compile_sh')
    requiredActions.push('Create a top-level compile.sh file in the workspace root.')
  } else if (!compileExecutable) {
    reasonCodes.push('compile_sh_not_executable')
    requiredActions.push('Run chmod +x ./compile.sh so test -x ./compile.sh passes.')
  }
  if (relativeImplementationFiles.length === 0) {
    reasonCodes.push('missing_source_files')
    requiredActions.push('Write at least one implementation/build source file needed for compile.sh to build ./executable; header-only files are not enough.')
  }
  if (relativeImplementationFiles.length > 0 && !implementationWrittenThrough) {
    reasonCodes.push('bootstrap_scaffold_not_replaced')
    requiredActions.push('Replace the runner-provided scaffold implementation with agent-authored source code before scoring.')
  }
  return {
    schema_version: 1,
    ok: compileExists && compileExecutable && relativeImplementationFiles.length > 0 && implementationWrittenThrough,
    checks: {
      compile_sh_exists: compileExists,
      compile_sh_executable: compileExecutable,
      source_files_present: relativeImplementationFiles.length > 0,
      implementation_files_present: relativeImplementationFiles.length > 0,
      implementation_written_through_after_bootstrap: implementationWrittenThrough,
      reference_executable_present_before_packaging: referenceExecutable,
    },
    source_file_count: relativeSourceFiles.length,
    source_files: relativeSourceFiles,
    implementation_file_count: relativeImplementationFiles.length,
    implementation_files: relativeImplementationFiles,
    reason_codes: reasonCodes,
    required_actions: requiredActions,
    runner_normalizations: runnerNormalizations,
  }
}

async function implementationWrittenThroughAfterBootstrap(
  workspaceRoot: string,
  runnerNormalizations: readonly ProgramBenchSubmissionContractNormalization[],
  implementationFiles: readonly string[],
): Promise<boolean> {
  const bootstrapFiles = new Set(
    runnerNormalizations
      .filter((item) => item.kind === 'runner_bootstrap_submission_skeleton' && item.applied)
      .flatMap((item) => item.files ?? [])
      .filter((file) => file !== 'compile.sh'),
  )
  if (!bootstrapFiles.size) return true
  for (const file of implementationFiles) {
    if (!bootstrapFiles.has(file)) return true
    const content = await readFile(join(workspaceRoot, file), 'utf8').catch(() => '')
    if (!isProgramBenchBootstrapPlaceholder(file, content)) return true
  }
  return false
}

function isProgramBenchBootstrapPlaceholder(file: string, content: string): boolean {
  const normalized = content.trim()
  if (file === 'main.go') return normalized === 'package main\n\nfunc main() {}'.trim()
  if (file === 'main.rs') return normalized === 'fn main() {}'
  if (file === 'main.py') return normalized === 'def main():\n    pass\n\nif __name__ == "__main__":\n    main()'.trim()
  if (file === 'Main.java') return normalized === 'public class Main { public static void main(String[] args) { } }'
  if (file === 'main.js') return normalized === 'process.exit(0)'
  if (file === 'main.c') return normalized === 'int main(int argc, char **argv) { (void)argc; (void)argv; return 0; }'
  return false
}

export async function maybeNormalizeProgramBenchCompileShExecutable(
  workspaceRoot: string,
  contract: ProgramBenchSubmissionContract,
  enabled: boolean,
): Promise<{ applied: boolean; reason: string }> {
  if (!enabled) return { applied: false, reason: 'disabled' }
  if (!contract.checks.compile_sh_exists) return { applied: false, reason: 'compile.sh is missing' }
  if (contract.checks.compile_sh_executable) return { applied: false, reason: 'compile.sh is already executable' }
  await chmod(join(workspaceRoot, 'compile.sh'), 0o755)
  return { applied: true, reason: 'runner normalized an existing top-level compile.sh executable bit before packaging' }
}

export function compareProgramBenchSubmissionContracts(
  before: ProgramBenchSubmissionContract,
  after: ProgramBenchSubmissionContract,
): ProgramBenchSubmissionContractProgress {
  const beforeReasons = new Set(before.reason_codes)
  const afterReasons = new Set(after.reason_codes)
  const resolved = before.reason_codes.filter((reason) => !afterReasons.has(reason))
  const added = after.reason_codes.filter((reason) => !beforeReasons.has(reason))
  const sourceFileDelta = after.source_file_count - before.source_file_count
  const implementationFileDelta = after.implementation_file_count - before.implementation_file_count
  const compileShCreated = !before.checks.compile_sh_exists && after.checks.compile_sh_exists
  const compileShBecameExecutable = !before.checks.compile_sh_executable && after.checks.compile_sh_executable
  const improved = after.ok
    || resolved.length > 0
    || implementationFileDelta > 0
    || compileShCreated
    || compileShBecameExecutable
    || (!before.checks.implementation_written_through_after_bootstrap && after.checks.implementation_written_through_after_bootstrap)
  const regressed = added.length > 0
    || implementationFileDelta < 0
    || (before.checks.implementation_written_through_after_bootstrap && !after.checks.implementation_written_through_after_bootstrap)
    || (before.checks.compile_sh_exists && !after.checks.compile_sh_exists)
    || (before.checks.compile_sh_executable && !after.checks.compile_sh_executable)
  return {
    classification: after.ok ? 'contract_satisfied' : improved ? 'progress' : regressed ? 'regression' : 'no_progress',
    improved,
    resolved_reason_codes: resolved,
    new_reason_codes: added,
    remaining_reason_codes: after.reason_codes,
    source_file_delta: sourceFileDelta,
    implementation_file_delta: implementationFileDelta,
    compile_sh_created: compileShCreated,
    compile_sh_became_executable: compileShBecameExecutable,
  }
}

export async function collectProgramBenchSourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.agent-kernel' || entry.name === '.claude' || entry.name === '.codex') continue
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
      } else if (isProgramBenchSourceFile(entry.name)) {
        out.push(entryPath)
      }
    }
  }
  await visit(root)
  return out
}

function isProgramBenchSourceFile(name: string): boolean {
  if (name === 'compile.sh') return false
  return /\.(c|cc|cpp|cxx|h|hpp|go|rs|sh|py|java|js|ts|mk)$/i.test(name) || name === 'Makefile'
}

function isProgramBenchImplementationFile(path: string): boolean {
  const name = path.split('/').at(-1) ?? path
  if (name === 'Makefile') return true
  return /\.(c|cc|cpp|cxx|go|rs|sh|py|java|js|ts|mk)$/i.test(name)
}
