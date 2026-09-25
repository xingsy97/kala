<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/dashboard/public/brand/kala-wordmark-light.svg">
  <img src="packages/dashboard/public/brand/kala-wordmark.svg" alt="Kala" width="220">
</picture>

# Kala

Kala is a self-hosted dashboard for running coding agents across your
workspaces. Switch between sessions and machines, follow what an agent is doing,
and inspect its work without losing the conversation.

> Pre-release software. The current public release line is `v0.2.0-rc.*`; APIs,
storage, and deployment contracts may change before 1.0.

## What you can do

- **Work across machines** — connect workspace executors, see their online
  status, and switch between sessions from one dashboard.
- **Follow the work** — use the Task Graph for multi-step plans, tool activity
  timelines for individual calls, and sub-agent cards for delegated work.
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
ANTHROPIC_API_KEY=<provider-key> pnpm host:dev
pnpm dashboard:dev
```

Open the Dashboard URL printed by Vite. For workspace tools, start an executor
from the workspace you want Kala to operate on:

```bash
pnpm --filter @agent-kernel/executor dev -- --host http://localhost:3000 --sandbox-root <workspace-root>
```

Provider endpoints and model choices can also be configured in Dashboard
Settings. Never commit provider credentials or local configuration.

## Releases

GitHub Releases are the distribution entry point **once a public release is
published**. You do not need the GitHub CLI. For a published Portable release,
use the release's `run.sh` bootstrapper (Linux/macOS, with `curl`, `bash`, `wget`
and `sha256sum` or `shasum`). The command uses the latest published release:

```bash
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL "https://github.com/xingsy97/akernel/releases/latest/download/run.sh" | bash'
```

Review the download source before executing network code. The bootstrapper
verifies downloaded executable and Dashboard assets against `SHA256SUMS` from
its release; checksums alone do not prove publisher identity. This command
requires a published release with those assets and fails if none exists. Do
not run it with `sudo`; configure a model provider and connect a workspace
Executor after the Host starts. See the source quick start above if no public
release is available yet.

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
Browser Dashboard
      │
      ▼
Runtime Host ──► model provider
      │
      ├── append-only session log
      ├── pure kernel reducer
      └── outbound executor fleet ──► shell / file / git / terminal tools
```

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
