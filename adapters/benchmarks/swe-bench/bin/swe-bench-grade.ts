#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'

const request = await readStdin()
const python = [
  'import json, os, pathlib, subprocess, sys, tempfile, time',
  'from swebench.harness.grading import get_eval_report',
  'from swebench.harness.constants import APPLY_PATCH_FAIL, TESTS_TIMEOUT',
  'from swebench.harness.test_spec.test_spec import make_test_spec',
  'req = json.load(sys.stdin)',
  'expected = os.environ.get("AGENT_EVAL_SWEBENCH_HARNESS_REVISION")',
  'assert expected == req["harnessRevision"], "SWE-Bench harness revision mismatch"',
  'instance = req["instance"]',
  'prediction = {"instance_id": instance["instance_id"], "model_name_or_path": req["modelNameOrPath"], "model_patch": req["modelPatch"]}',
  'spec = make_test_spec(instance)',
  'work = pathlib.Path("/workspace")',
  'subprocess.run(["git", "reset", "--hard", instance["base_commit"]], cwd=work, check=True, capture_output=True)',
  'subprocess.run(["git", "clean", "-fdx"], cwd=work, check=True, capture_output=True)',
  'patch = req["modelPatch"].encode()',
  'applied = False',
  'apply_logs = []',
  'for command in (["git", "apply", "--verbose", "-"], ["git", "apply", "--verbose", "--reject", "-"], ["patch", "--batch", "--fuzz=5", "-p1", "-i", "-"]):',
  '    if not patch:',
  '        apply_logs.append({"argv": command, "exitCode": 1, "stdout": "", "stderr": "empty model patch"})',
  '        break',
  '    result = subprocess.run(command, cwd=work, input=patch, capture_output=True)',
  '    apply_logs.append({"argv": command, "exitCode": result.returncode, "stdout": result.stdout.decode(errors="replace"), "stderr": result.stderr.decode(errors="replace")})',
  '    if result.returncode == 0:',
  '        applied = True',
  '        break',
  'if not applied:',
  '    with tempfile.NamedTemporaryFile(mode="w", prefix="agent-eval-swe-bench-apply-", delete=False) as failure_log:',
  '        failure_log.write(APPLY_PATCH_FAIL)',
  '        failure_path = failure_log.name',
  '    try:',
  '        report = get_eval_report(test_spec=spec, prediction=prediction, test_log_path=failure_path, include_tests_status=True)',
  '    finally:',
  '        pathlib.Path(failure_path).unlink(missing_ok=True)',
  '    print(json.dumps({"schemaVersion": 1, "harnessRevision": req["harnessRevision"], "completed": False, "patchApplied": False, "resolved": False, "timedOut": False, "report": report, "applyLogs": apply_logs, "testOutput": ""}))',
  '    raise SystemExit(0)',
  'with tempfile.TemporaryDirectory(prefix="agent-eval-swe-bench-") as directory:',
  '    root = pathlib.Path(directory)',
  '    eval_path = root / "eval.sh"',
  '    test_log = root / "test-output.log"',
  '    eval_path.write_text(spec.eval_script)',
  '    started = time.monotonic()',
  '    timed_out = False',
  '    try:',
  '        completed = subprocess.run(["bash", str(eval_path)], cwd=work, capture_output=True, timeout=req["testTimeoutSeconds"])',
  '        output = completed.stdout + completed.stderr',
  '        exit_code = completed.returncode',
  '    except subprocess.TimeoutExpired as error:',
  '        timed_out = True',
  '        output = (error.stdout or b"") + (error.stderr or b"") + bytes([10]) + TESTS_TIMEOUT.encode()',
  '        exit_code = 124',
  '    test_log.write_bytes(output)',
  '    report = get_eval_report(test_spec=spec, prediction=prediction, test_log_path=test_log, include_tests_status=True)',
  '    instance_report = report.get(instance["instance_id"], {})',
  '    payload = {"schemaVersion": 1, "harnessRevision": req["harnessRevision"], "completed": not timed_out, "patchApplied": True, "resolved": bool(instance_report.get("resolved", False)), "timedOut": timed_out, "testExitCode": exit_code, "testDurationMs": int((time.monotonic() - started) * 1000), "report": report, "applyLogs": apply_logs, "testOutput": output.decode(errors="replace")}',
  '    print(json.dumps(payload))',
].join('\n')

const temporaryGitConfig = '/tmp/agent-eval-grader-' + process.pid + '-' + Date.now().toString(36) + '.gitconfig'
await writeFile(temporaryGitConfig, '[safe]\n\tdirectory = /workspace\n', { encoding: 'utf8', mode: 0o600 })
try {
  const child = spawn(process.env.AGENT_EVAL_PYTHON_BINARY ?? 'python', ['-c', python], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: temporaryGitConfig } })
  child.stdin.end(request)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  process.stdout.write(Buffer.concat(stdout))
  process.stderr.write(Buffer.concat(stderr))
  if (exitCode !== 0) process.exitCode = exitCode ?? 1
} finally {
  await unlink(temporaryGitConfig).catch(() => undefined)
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) throw new Error('SWE-Bench grade request is required on stdin')
  return Buffer.concat(chunks)
}
