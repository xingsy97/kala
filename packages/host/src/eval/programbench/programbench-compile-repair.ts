import type { ProgramBenchCompileProbe } from './programbench-compile.js'
import type { ProgramBenchPromptCase } from './programbench-prompt.js'
import type { ProgramBenchSubmissionContract } from './programbench-contract.js'

export type ProgramBenchCompileRepairClassification =
  | 'compile_passed'
  | 'compile_failed_after_contract'
  | 'compile_timeout_after_contract'
  | 'compile_probe_unavailable'
  | 'artifact_contract_not_satisfied'

export type ProgramBenchCompileRepairAction =
  | 'accept_compile'
  | 'continue_compile_repair'
  | 'stop_until_artifact_contract_fixed'
  | 'stop_compile_probe_unavailable'

export type ProgramBenchCompileRepairControl = {
  classification: ProgramBenchCompileRepairClassification
  action: ProgramBenchCompileRepairAction
  unfinished: boolean
  reason: string
  compile_reason_codes: readonly string[]
  stderr_preview: string
}

const CONTAINER_BASH_WORKSPACE = '/workspace'

export function classifyProgramBenchCompileRepair(input: {
  contract: ProgramBenchSubmissionContract
  compileProbe?: ProgramBenchCompileProbe | null
}): ProgramBenchCompileRepairControl {
  if (!input.contract.ok) {
    return {
      classification: 'artifact_contract_not_satisfied',
      action: 'stop_until_artifact_contract_fixed',
      unfinished: true,
      reason: 'minimum ProgramBench artifacts are missing; run artifact contract repair before compile repair',
      compile_reason_codes: [],
      stderr_preview: '',
    }
  }
  if (!input.compileProbe) {
    return {
      classification: 'compile_probe_unavailable',
      action: 'stop_compile_probe_unavailable',
      unfinished: true,
      reason: 'compile probe is missing; run the no-model compile probe before compile repair',
      compile_reason_codes: [],
      stderr_preview: '',
    }
  }
  if (input.compileProbe.ok) {
    return {
      classification: 'compile_passed',
      action: 'accept_compile',
      unfinished: false,
      reason: 'compile probe passed',
      compile_reason_codes: input.compileProbe.reason_codes,
      stderr_preview: preview(input.compileProbe.stderr),
    }
  }
  if (input.compileProbe.reason_codes.includes('compile_timeout')) {
    return {
      classification: 'compile_timeout_after_contract',
      action: 'continue_compile_repair',
      unfinished: true,
      reason: 'minimum artifacts exist but compile probe timed out',
      compile_reason_codes: input.compileProbe.reason_codes,
      stderr_preview: preview(input.compileProbe.stderr),
    }
  }
  return {
    classification: 'compile_failed_after_contract',
    action: 'continue_compile_repair',
    unfinished: true,
    reason: 'minimum artifacts exist but compile probe failed',
    compile_reason_codes: input.compileProbe.reason_codes,
    stderr_preview: preview(input.compileProbe.stderr),
  }
}

export function buildProgramBenchCompileRepairPrompt(input: {
  item: ProgramBenchPromptCase
  workspaceRoot: string
  contract: ProgramBenchSubmissionContract
  compileProbe: ProgramBenchCompileProbe
}): string {
  const sourceFileList = input.contract.source_files?.length
    ? input.contract.source_files.map((file) => `- ${file}`).join('\n')
    : '- none recorded'
  const implementationFileList = input.contract.implementation_files?.length
    ? input.contract.implementation_files.map((file) => `- ${file}`).join('\n')
    : '- none recorded'
  const stderr = preview(input.compileProbe.stderr, 4_000) || '(no stderr captured)'
  const stdout = preview(input.compileProbe.stdout, 2_000) || '(no stdout captured)'
  return `You are continuing the same ProgramBench clean-room reconstruction task.

Instance: ${input.item.instance_id}
Repository: ${input.item.repository ?? 'unknown'}
Language: ${input.item.language ?? 'unknown'}

Host workspace path for filesystem tools: ${input.workspaceRoot}
Bash workspace path: ${CONTAINER_BASH_WORKSPACE}

The minimum artifact contract is already satisfied: source files exist and ./compile.sh exists. The next blocker is compile failure.

Compile repair rule:
- Do not restart from scratch.
- Do not investigate prior benchmark run directories or outside workspaces.
- Focus on fixing the current source files and ./compile.sh so that running ./compile.sh from the workspace root builds a fresh top-level ./executable.
- Use filesystem tools with the host workspace path or relative paths. Use ${CONTAINER_BASH_WORKSPACE} only inside bash commands.
- Before any final response, run ./compile.sh and confirm it exits 0 and creates ./executable.
- If the compiler reports missing symbols, missing main, missing headers, or linker errors, edit the source/build files directly before responding.

Detected source files:
${sourceFileList}

Detected implementation/build source files:
${implementationFileList}

Compile probe status: ${input.compileProbe.status}
Compile probe reason codes:
${input.compileProbe.reason_codes.map((reason) => `- ${reason}`).join('\n') || '- none'}

Compile command:
${input.compileProbe.command.join(' ')}

Compile stderr:
${stderr}

Compile stdout:
${stdout}

Repair objective:
- Make the existing code compile under the benchmark container.
- Keep the final source code self-contained.
- Leave the fixed files in the workspace root.
- Do not finish with a promise to fix compilation; perform the file edits and compile check first.`
}

function preview(value: string, maxChars = 1_000): string {
  const text = String(value ?? '').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.floor(maxChars / 2))}\n[...truncated...]\n${text.slice(-Math.floor(maxChars / 2))}`
}
