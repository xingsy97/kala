# Benchmark eval security model

The container-backed benchmarks (`program-bench`, `swe-marathon`,
`terminal-bench-2_1`) **execute untrusted, dataset-supplied content**:
Dockerfiles, `run-tests.sh` / `test.sh` verifiers, reference `solution.sh`,
`compile.sh`, task `instruction` text, and agent commands. This is inherent to
running a benchmark — the point is to build and test third-party code. The
threat model below states what is and is not defended.

## Threats

1. **Prompt injection** — a malicious `instruction.md` / `task.yaml` instruction
   can try to make the *agent under test* attack the harness or exfiltrate data.
   This is not something the runner can neutralize (the agent is *supposed* to
   read the instruction). It is contained by the agent's own sandbox and by the
   isolation below; never run a benchmarked agent with host credentials in scope.
2. **Malicious code execution** — Dockerfile/verifier/solution/compile scripts
   run arbitrary code. Contained by running them inside disposable, resource-
   and privilege-limited Docker containers.
3. **Shell/argument injection** — task ids and paths flow into `docker`/shell
   invocations. All external process calls use `spawn(cmd, [args])` array form
   (no shell parsing); task ids are sanitized to `[a-z0-9_.-]`; paths are passed
   as discrete arguments. There is no string-concatenated shell command built
   from dataset input.
4. **Host compromise / sandbox escape** — a container escape or an un-sandboxed
   host execution could persist on the box. Mitigated as below; residual risk is
   accepted only when the operator explicitly opts in on an already-sandboxed
   host.

## Isolation guarantees

- **No host execution by default (program-bench).** `runProgramBenchTrial`
  refuses to run an untrusted `agentCommand` or fall back to a host `compile.sh`
  unless `allowHostExecution: true`. That opt-in is CLI-only
  (`--allow-host-execution`) — it is **never** reachable over HTTP/the dashboard,
  so a remote request cannot escalate to host code execution.
- **Disposable containers.** Every container uses `docker run --rm`. Images the
  runner builds are named with the run-scoped prefix `ak-eval-<kind>-<runId>-
  <taskId>` and only the run's own prefixed image is removed. Pre-existing
  containers/images are never touched; no `docker system prune`, no bulk removal.
- **Resource limits.** `--cpus`, `--memory`, and `--pids-limit` cap each trial
  (e.g. 2 CPU/2g/512 pids for compile probes; 4 CPU/8g/2048 pids for verifiers)
  to contain fork bombs and memory exhaustion on the shared host.
- **Privilege restriction.** `--security-opt no-new-privileges` plus a targeted
  `--cap-drop` of the dangerous capabilities (`NET_RAW`, `SYS_ADMIN`,
  `SYS_PTRACE`, `SYS_MODULE`, `MKNOD`). Baseline file-ownership caps are kept so
  legitimate verifiers can write their `/logs` artifacts across the bind mount.
- **Network.** The program-bench compile probe runs with `--network none`. The
  swe-marathon verifier defaults to `--network none` and only uses `bridge` when
  the task's `task.toml` declares `network_mode = "public"`. Terminal-Bench 2.1
  keeps networking because its `run-tests.sh` legitimately installs dependencies
  (apt/uv), but is otherwise constrained by the limits above.
- **No docker socket / privileged mode.** The runners never mount
  `/var/run/docker.sock` and never pass `--privileged`.

## Operator guidance

- Run benchmark evals on a disposable host (VM/CI runner), not a machine holding
  secrets or production credentials.
- Do not pass `--allow-host-execution` unless the whole process already runs
  inside a throwaway sandbox.
- Datasets should come from trusted sources; treat any third-party task tree as
  potentially malicious and rely on the container isolation above.
