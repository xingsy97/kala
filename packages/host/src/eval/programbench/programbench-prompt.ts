import type { ProgramBenchSubmissionContract } from './programbench-contract.js'

export type ProgramBenchPromptCase = {
  instance_id: string
  repository?: string
  language?: string
  difficulty?: string | null
}

const CONTAINER_BASH_WORKSPACE = '/workspace'

export function buildProgramBenchPrompt(item: ProgramBenchPromptCase, workspaceRoot: string): string {
  return `You are solving a ProgramBench clean-room reconstruction task.

Instance: ${item.instance_id}
Repository: ${item.repository ?? 'unknown'}
Language: ${item.language ?? 'unknown'}
Difficulty: ${item.difficulty ?? 'unspecified'}

You are given only the task workspace contents for this instance. The workspace may include documentation, license files, and a reference executable. Reconstruct a complete working codebase that matches the documented behavior of the original compiled program.

Host workspace path for filesystem tools: ${workspaceRoot}
Bash workspace path: ${CONTAINER_BASH_WORKSPACE}

The filesystem tools use host paths. The bash tool runs inside the benchmark container, where the workspace is mounted at ${CONTAINER_BASH_WORKSPACE}. For bash commands, use relative paths from the current directory or ${CONTAINER_BASH_WORKSPACE}; do not cd to the host workspace path.

This workspace is the only benchmark task directory for this run. Treat any other experiments/evals/2026-07-agent-benchmark-comparison/artifacts/program-bench/... directory as prior-run evidence that is out of scope and must not be read or copied.

Submission-first workflow:
- Runner-provided scaffold: the workspace may already contain ./compile.sh and a language entrypoint such as ./main.c created by the benchmark runner before inference. Treat those files as placeholder scaffolding only, not as a completed solution.
- Replace or extend any runner-provided scaffold with a real reconstructed implementation. Passing test -x ./compile.sh, or compiling an empty placeholder program, is not enough; behavior must match the reference executable.
- Before doing extended reference-executable probing, create the minimum submission skeleton: a top-level ./compile.sh and at least one source file appropriate for the task language.
- For C tasks, the first source skeleton should normally be ./seqtk.c or ./main.c plus any headers you know you need.
- Filesystem tools run on the host workspace path, not /workspace. If you use write/edit/read filesystem tools, use the host workspace path or a relative path such as ./seqtk.c. Use /workspace only inside bash commands.
- If a filesystem write to /workspace fails, immediately retry with a relative path or the host workspace path. Do not continue as if the file was written.
- The initial skeleton may be incomplete, but it must compile or clearly show the intended build path as soon as possible.
- After the skeleton exists, iterate by probing the reference executable, implementing behavior, running ./compile.sh, and testing the produced ./executable.
- Do not spend the whole turn budget only collecting command usage. The benchmark gives no credit for analysis without files.

Rules:
- Do not use the internet, web search, web fetch, package registries, or external source lookup.
- Use only files, documentation, binaries, build tools, and tests available inside the current task workspace.
- Do not inspect /, ~, the repository root, prior benchmark run directories, or any path outside this workspace.
- If you need to list files with filesystem tools, use the host workspace path above. If you need to run shell commands, run them in ${CONTAINER_BASH_WORKSPACE} or use relative paths.
- Build and test locally where possible.
- Keep the final codebase self-contained.
- Provide a top-level compile.sh file.
- Make compile.sh executable with chmod +x compile.sh; the benchmark requires the executable bit, not just shell-compatible contents.
- Running ./compile.sh from the workspace root must build a fresh top-level ./executable.
- Do not rely on the reference executable remaining in the final submission; the evaluator removes any shipped ./executable before compilation.
- Do not include agent logs, transcripts, caches, or benchmark metadata in the final submission.
- Do not finish by describing what you are about to write. Finish only after the files are written.
- A final answer like "now I will write the source" is a failed run. If source is still missing, call a write/edit/bash tool before responding.
- Before your final response, verify that test -x ./compile.sh passes and that ./compile.sh produces ./executable in the workspace.

When finished, leave the reconstructed codebase in the workspace root. The benchmark runner will package it as submission.tar.gz.`
}

export function buildProgramBenchContractRepairPrompt(
  item: ProgramBenchPromptCase,
  workspaceRoot: string,
  contract: ProgramBenchSubmissionContract,
): string {
  const hasSourcesButNoEntrypoint = contract.checks.source_files_present && !contract.checks.compile_sh_exists
  const missingSources = !contract.checks.source_files_present
  const sourceFileList = contract.source_files?.length
    ? contract.source_files.map((file) => `- ${file}`).join('\n')
    : '- none recorded'
  const implementationFileList = contract.implementation_files?.length
    ? contract.implementation_files.map((file) => `- ${file}`).join('\n')
    : '- none recorded'
  return `You are continuing the same ProgramBench clean-room reconstruction task.

Instance: ${item.instance_id}
Host workspace path for filesystem tools: ${workspaceRoot}
Bash workspace path: ${CONTAINER_BASH_WORKSPACE}

The filesystem tools use host paths. The bash tool runs inside the benchmark container, where the workspace is mounted at ${CONTAINER_BASH_WORKSPACE}. For bash commands, use relative paths from the current directory or ${CONTAINER_BASH_WORKSPACE}; do not cd to the host workspace path.

The previous attempt did not satisfy the benchmark submission contract.

Immediate repair rule:
- Existing ./compile.sh or source files may be runner-provided placeholder scaffolding. If behavior is missing or incomplete, replace or extend them into a real implementation instead of treating their existence as success.
- If the failed reason includes missing_compile_sh or missing_source_files, do not start by investigating the reference executable again.
- First create a top-level ./compile.sh and at least one source file, then make ./compile.sh executable. This must be done with a file-writing tool call before any final response.
- If both source files and compile.sh are missing, this is a minimum-artifact-completion task: write the source skeleton and compile.sh immediately, even if the implementation is incomplete.
- If source files already exist and only compile.sh is missing, this is an entrypoint-completion task: create ./compile.sh immediately around the existing source files instead of writing more analysis.
- Filesystem tools run on the host workspace path, not /workspace. If using write/edit/read filesystem tools, use a relative path or the host workspace path. Use /workspace only inside bash commands.
- Do not finish with a promise to write files. If the required files are missing, call a write/edit/bash tool before responding.
- Only after those files exist should you run additional reference probes or local tests.

Current completion-control focus:
${missingSources
  ? '- Source files are missing. Write at least one task-language source file and a top-level ./compile.sh before doing more analysis or ending the response.'
  : hasSourcesButNoEntrypoint
    ? '- Source files are already present but top-level ./compile.sh is missing. Create ./compile.sh first, make it executable, then run it.'
    : '- Satisfy every missing contract item before any final response.'}

Minimum artifact checkpoint:
- Before any final response, the workspace must contain a source/build file and ./compile.sh.
- If either is absent, the only acceptable next action is a file-writing tool call, not explanation.
- A response that says "I will create" or "let me write" without a file-writing tool call is still a failed repair.

Detected source files:
${sourceFileList}

Detected implementation/build source files:
${implementationFileList}

Failed contract reason codes:
${contract.reason_codes.map((reason) => `- ${reason}`).join('\n') || '- unknown'}

Required repair actions:
${contract.required_actions.map((action) => `- ${action}`).join('\n') || '- Re-check the workspace and satisfy the benchmark contract.'}

Contract requirements:
- Create a top-level ./compile.sh if it is missing.
- Make ./compile.sh executable with chmod +x ./compile.sh.
- Running ./compile.sh from the workspace root must build a fresh top-level ./executable.
- Keep the final source code self-contained in this workspace.
- Do not use the internet, web search, web fetch, package registries, external repositories, prior benchmark artifacts, or files outside this workspace.
- The original reference ./executable may exist in the workspace, but the benchmark packager excludes it and the evaluator removes shipped executables before compiling.

Repair only what is needed to satisfy the benchmark submission contract and preserve any useful source already written. Before your final response, run test -x ./compile.sh and ./compile.sh, then confirm it creates ./executable.`
}
