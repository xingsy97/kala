<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/dashboard/public/brand/kala-wordmark-light.svg">
  <img src="packages/dashboard/public/brand/kala-wordmark.svg" alt="Kala" width="220">
</picture>

# Kala

Kala is a self-hosted command center for coding agents. Run agents across
machines, keep concurrent sessions organized, and see plans, tool activity, and
workspace changes as they happen.

## What you can do

- **Work across machines** — connect workspace executors, see their online
  status, and switch between sessions from one dashboard.
- **DAG-first task planning & tracking** — map dependencies, see what is done
  or blocked, and follow delegated sub-agents alongside live tool activity.
- **Keep context in view** — check context usage, inspect attachments and
  conversation history, and choose between simple and full composer modes.
- **Inspect without leaving the session** — use the right panel for files, Git
  changes, a workspace terminal, and runtime status and trace events.
- **Stay in control** — review approvals and choose a supported agent runtime
  and model. Workspace tools run through outbound executors rather than exposing
  your workstation directly.

## Quick start from source

```bash
corepack enable
corepack prepare pnpm@11.3.0 --activate
pnpm install --frozen-lockfile
pnpm run build
```

Run the Host and Dashboard in separate terminals:

```bash
# Terminal 1 — any OpenAI-compatible /v1 endpoint
KALA_PROVIDER=openai OPENAI_BASE_URL=https://api.example.com/v1 \
  OPENAI_API_KEY='replace-with-your-key' HOST_MODEL='your-model-id' pnpm host:dev
# Terminal 2
pnpm dashboard:dev
```

Open the Dashboard URL printed by Vite. For workspace tools, start an executor
from the workspace you want Kala to operate on:

```bash
pnpm --dir packages/executor dev -- --host http://localhost:3000 --sandbox-root '/absolute/path/to/workspace'
```

Provider endpoints and model choices can also be configured in Dashboard
Settings. Never commit provider credentials or local configuration.

## Releases

GitHub Releases distribute Kala's portable Host and Dashboard. No GitHub CLI
is needed: on Linux or macOS, use the latest published release (requires `curl`,
`bash`, `wget`, and `sha256sum` or `shasum`):

```bash
set -o pipefail; curl --proto '=https' --tlsv1.2 -fsSL https://github.com/xingsy97/kala/releases/latest/download/run.sh | bash
```

Run this from Bash or another shell supporting `pipefail`, so download errors
are not hidden by the pipe. Review the download source before running network
code. The bootstrapper checks release assets against `SHA256SUMS`; checksums do
not establish publisher identity. The command requires a published Kala
release and fails if none exists. Do not run it with `sudo`. Configure a model
provider and connect a workspace Executor after the Host starts.

For the **Linux Desktop client** connecting to an existing trusted Kala server,
open that server's `/downloads/desktop/index.html` and copy its one-command
`curl` installer. It verifies an immutable package before installation. It is
not a Host installer, and the page only offers it when a Desktop package exists.
Dedicated and Private Cloud bundles are preview artifacts, not certified
installations in this bootstrap release; consult the operator runbooks and do
not pipe a script into a privileged shell.

Release and deployment details live in the runbooks instead of this README:

- [Public release readiness](docs/operations/public-release-readiness.md)
- [Linux desktop release](docs/operations/linux-desktop-release.md)
- [Dedicated operator CLI](docs/operations/dedicated-operator-cli.md)
- [Private Cloud release](docs/operations/private-cloud-release.md)
- [Release support policy](docs/operations/release-support-policy.md)

## Architecture at a glance

```text
Browser Dashboard ── Socket.IO ──► Host (session orchestration + event log)
                                       │ calls with (state, event, config)
                                       ▼
                              Microkernel / state machine
                   step(state, event, config) → { next, effects }
                                       │ declarative effects (no I/O in kernel)
                                       ▼
                                Host effect runner
                                  ├──► model provider
                                  └──► workspace executors ──► file / shell / Git tools
                                       │
                            results return as new events to the Host
```

The microkernel is a **pure-function reducer**: its transition table determines
which events are valid in each state and returns a new state plus declarative
effects. The Host persists session events, executes those effects, then feeds
results back as events. Planning and subagent orchestration live outside the
kernel. See the [kernel implementation](packages/kernel/src/core.ts) and
[pure-reducer design](docs/meta/adr/0001-pure-reducer.md).

Deployment modes share the same core runtime model:

- **Portable** for one-person or quick local/VM installs.
- **Dedicated** for a single tenant with blue/green Runtime slots.
- **Private Cloud** for multi-tenant self-hosted control planes.

See the [deployment mode contract](docs/architecture/deployment-mode-contract.md)
for the normative boundary between these modes.

## Repository map

- [packages/kernel](packages/kernel/) — reducer, session state, and runtime contracts
- [packages/host](packages/host/) — runtime, persistence, providers, HTTP and Socket.IO
- [packages/executor](packages/executor/) — outbound tool runner and service lifecycle
- [packages/dashboard](packages/dashboard/) — responsive product UI and PWA
- [deploy](deploy/) — Dedicated, Private Cloud, Identity, and evaluation deployment assets
- [docs](docs/) — architecture, operations, protocols, and design notes
- [scripts](scripts/) — build, verification, security, release, and acceptance tooling

Start with the [documentation index](docs/README.md),
[contribution guide](CONTRIBUTING.md), and [security policy](SECURITY.md).

## Development checks

```bash
pnpm run typecheck
pnpm run test:fast
pnpm run privacy:check
```

Release candidates require the broader evidence set described in the
[public release readiness runbook](docs/operations/public-release-readiness.md).

## License

Kala is available under the [MIT License](LICENSE). Third-party components remain
governed by their own licenses and notices.
