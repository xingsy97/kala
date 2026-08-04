import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { SweBenchBenchmarkAdapter } from './index.js'

const runFile = promisify(execFile)
const root = resolve(new URL('../../../..', import.meta.url).pathname)
const generator = resolve(root, 'adapters/benchmarks/swe-bench/fixtures/generate.py')

describe('standalone SWE-Bench fixture generator', () => {
  it('emits canonical adapter input and rejects missing immutable lineage', async () => {
    const program = String.raw`
import importlib.util, json
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("swe_bench_fixture_generator", r"${generator}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
row = {
  "instance_id": "sympy__sympy-20590", "repo": "sympy/sympy",
  "base_commit": "base-revision", "problem_statement": "Fix it.",
  "version": "1.8", "FAIL_TO_PASS": ["test_a"],
  "PASS_TO_PASS": [], "test_patch": "diff --git a/test b/test\n"
}
options = SimpleNamespace(
  dataset_id="swe-bench-verified", dataset_version="verified-v1", split="test",
  harness_revision="f7bbbb2ccdf479001d6467c9e34af59e44a840f9", license="MIT",
  evaluation_permission="SWE-Bench benchmark evaluation", test_timeout_seconds=1800, namespace="swebench"
)
lineage = {row["instance_id"]: {
  "officialInstanceImageDigest": "docker.io/swebench/instance@sha256:" + "a" * 64,
  "trialSandboxImageDigest": "local:" + "b" * 64,
  "repositoryManifestHash": "c" * 64
}}
value = module.build_task_pack_input(row, lineage, options)
try:
  module.build_task_pack_input(row, {}, options)
except ValueError as error:
  missing = str(error)
else:
  raise AssertionError("missing lineage was accepted")
print(json.dumps({"value": value, "missing": missing}, separators=(",", ":")))
`
    const result = await runFile('python3', ['-c', program], { encoding: 'utf8' })
    const output = JSON.parse(result.stdout) as { value: unknown; missing: string }
    const [task] = await new SweBenchBenchmarkAdapter().resolveTasks(output.value)
    expect(task).toMatchObject({
      taskId: 'sympy__sympy-20590',
      taskPackId: 'swe-bench',
      repository: { revision: 'base-revision', repositoryManifestHash: 'c'.repeat(64) },
      benchmarkInput: {
        harnessRevision: 'f7bbbb2ccdf479001d6467c9e34af59e44a840f9',
        officialInstanceImageDigest: 'docker.io/swebench/instance@sha256:' + 'a'.repeat(64),
        trialSandboxImageDigest: 'local:' + 'b'.repeat(64),
      },
    })
    expect(output.missing).toContain('lineage manifest has no entry')
    expect(await readFile(generator, 'utf8')).not.toContain('AgentRlTask')
  })
})
