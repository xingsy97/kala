<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/dashboard/public/brand/kala-wordmark-light.svg">
  <img src="packages/dashboard/public/brand/kala-wordmark.svg" alt="Kala" width="220">
</picture>

# Kala

Kala is a self-hosted runtime and dashboard for coding agents. It keeps agent
sessions replayable, routes work across model providers and tool executors, and
turns multi-step agent work into a clear product UI for humans.

> Pre-release software. The current public release line is `v0.2.0-rc.*`; APIs,
storage, and deployment contracts may change before 1.0.

![Kala dashboard preview](docs/assets/kala-dashboard-preview.gif)

## Why Kala

- **Replayable sessions** — an append-only session log drives a pure kernel, so
  agent state, effects, approvals, and tool results can be inspected later.
- **Workspace-aware UI** — keep multiple workspaces and sessions visible without
  losing context.
- **Readable agent activity** — dot-line timelines, grouped tool calls, and
  sub-agent groups make long-running work easier to follow.
- **Bring your own runtime** — use Kala Kernel for full self-hosted control or a
  lighter runtime such as GitHub Copilot when that is enough.
- **Executor-first tools** — shell, file, git, terminal, and browser-adjacent
  tools run through outbound executors instead of exposing a workstation directly.

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

GitHub Releases are the distribution entry point. A release is expected to include
clear notes, checksums, and the relevant portable, desktop, or operator assets for
that channel. Download assets and checksums from the same release before running
them.

```bash
gh release download v0.2.0-rc.1 --repo xingsy97/akernel --pattern SHA256SUMS
sha256sum --ignore-missing --check SHA256SUMS
```

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

- `packages/kernel` — reducer, replay contracts, session state
- `packages/host` — runtime, persistence, providers, HTTP and Socket.IO
- `packages/executor` — outbound tool runner and service lifecycle
- `packages/dashboard` — responsive product UI and PWA
- `deploy` — Dedicated, Private Cloud, Identity, and evaluation deployment assets
- `docs` — architecture, operations, protocols, and design notes
- `scripts` — build, verification, security, release, and acceptance tooling

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
