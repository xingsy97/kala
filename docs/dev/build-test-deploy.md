# Build, Test, And Deploy

This runbook keeps common local and remote operations fast without adding many package scripts.

## Targeted Tests

Use `pnpm exec` inside the selected package when running a single Vitest file:

```bash
pnpm --filter @agent-kernel/host exec vitest run src/loop.test.ts
```

Avoid passing a file after the package `test` script:

```bash
pnpm --filter @agent-kernel/host test -- src/loop.test.ts
```

That form invokes the package script and can still run the full suite depending on how the script forwards arguments.

## TypeScript Builds

Package `tsconfig.json` files use incremental compiler metadata at `dist/.tsbuildinfo`. The cache is local build output and is ignored by git.

## Release Assets

Full local release build without native SEA assets:

```bash
pnpm run build:release-assets -- --repo <owner>/<repo> --no-native
```

Fast release rebundle after package and dashboard builds are already current:

```bash
pnpm run build:release-assets -- --repo <owner>/<repo> --no-native --skip-dashboard-build --skip-package-build
```

`--skip-dashboard-build` still requires `packages/dashboard/dist/index.html` to exist. If it is missing, the release script fails before producing a host bundle.

## Transactional Deploy

The normative restart and deployment contract is [`../architecture/graceful-restart-and-deployment.md`](../architecture/graceful-restart-and-deployment.md). This runbook must not weaken that contract.

Platform Dashboard releases are independent of Runtime releases. For Dedicated, use
`pnpm run deploy:dashboard -- stage` followed by `wait`, `status`, or `inspect`; the
Supervisor verifies the immutable archive and advances only Dashboard route state. For
Private Cloud, use `pnpm private-cloud:deploy-dashboard`; it replaces only the Dashboard
container and fails if Runtime or Ingress container identity changes. Portable continues to
ship and update one combined executable.

Use the single `deploy:remote` entry point for LXD and SSH. It builds and verifies release assets unless `--skip-build` is explicitly supplied. Inspect the supported command without selecting a target or causing side effects:

```bash
pnpm run deploy:remote -- --help
```

### LXD

The standard local LXD deployment is:

```bash
pnpm run deploy:remote -- --lxd <container>
```

The conventional legacy Portable-service defaults are `--host-url http://127.0.0.1:13000`, `--remote-bin /home/ubuntu/.bin`, and `--service agent-runlab-host`. Override them only when the target uses a different supervisor contract:

```bash
pnpm run deploy:remote -- \
  --lxd <container> \
  --host-url <host-url-reachable-from-container> \
  --remote-bin <remote-bin-dir> \
  --service <systemd-unit>
```

Use `--dry-run` to validate target selection without building, transferring, activating, restarting, or cleaning anything. Use `--skip-build` only when the current `release/` was already built; digest verification still runs.

### SSH

Deploy with explicit remote settings:

```bash
pnpm run deploy:remote -- \
  --ssh <ssh-target> \
  --host-url <host-url-reachable-from-remote> \
  --remote-bin <remote-bin-dir> \
  --service <systemd-unit>
```

Useful optional flags:

```bash
pnpm run deploy:remote -- \
  --ssh <ssh-target> \
  --host-url <host-url-reachable-from-remote> \
  --remote-bin <remote-bin-dir> \
  --service <systemd-unit> \
  --restart-mode checkpoint \
  --restart-timeout-ms 600000 \
  --status-timeout-ms 660000
```

Equivalent environment variables are available for local shell aliases or CI secrets:

```bash
AK_DEPLOY_SSH=<ssh-target>
AK_DEPLOY_HOST_URL=<host-url-reachable-from-remote>
AK_DEPLOY_REMOTE_BIN=<remote-bin-dir>
AK_DEPLOY_SERVICE=<systemd-unit>
```

SSH and LXD are transport adapters for the same target-side transaction. The command stages an immutable generation, validates its manifest, hands finalization to a worker outside the Host cgroup, atomically activates `current` after checkpoint readiness, and requests restart through `/runtime/restart`. Never replace it with direct live-file copies or a direct service restart.

### Self-deployment from a running Session

A deployment started from a Session running on the target Host must use durable asynchronous handoff. The supported topology is:

```text
Session on target Runtime Host
  -> external Tool Executor with repository and target access
  -> deploy:remote LXD or SSH transport
  -> external target-side finalizer
  -> checkpoint restart and planned continuation
```

The Runtime Host may be inside LXD, but the `--lxd` command normally runs on the Box Executor that can access the LXD daemon. Running it inside the target container itself is unsupported unless that environment independently has the repository, build toolchain, `lxc` access, and required privileges.

When the command prints `accepted: true`, the initiating Tool call must end immediately. Do not poll the transaction from that same Tool call: its durable Tool result is the origin barrier the finalizer is waiting for. A later Tool turn or an independent operator may read the reported transaction file and verify completion. A fixed sleep is not a valid substitute.

Final acceptance must check the transaction phase, PID change, `current` generation, exact bundle digest, HTTP readiness, Executor reconnection, participant cursor monotonicity, continuation outcome, and absence of new structured interrupted responses during the deployment window. Count structured `llm_response` events—not raw JSONL string occurrences, which may include quoted source code or Tool output.

Do not commit personal SSH targets, public domains, ports, container names, credentials, or machine paths into package scripts or docs.
