# Agent RunLab

Agent RunLab is a self-hosted coding-agent runtime and product UI built around a
replayable pure-function kernel. The kernel maps `(state, input)` to
`{ nextState, effects }`; the Runtime persists Sessions, calls model providers,
and routes tools to outbound-connected Executors.

> Pre-release software: the current public release target is `v0.2.0-rc.1`.
> Interfaces, storage, and operator workflows may change before 1.0.

## Choose a deployment

| Variant | Use it when | What is deployed |
|---|---|---|
| **Portable** | one person or a quick local/VM installation | one CJS file or native executable with embedded Dashboard |
| **Dedicated** | one tenant needs the full managed Platform lifecycle | Stable Ingress, blue/green Runtime slots, Deploy Supervisor, independent Dashboard |
| **Private Cloud** | multiple isolated tenants share a self-hosted control plane | Gateway/identity, tenant Runtime Units, independent Dashboard, PostgreSQL and object/storage services |

All three are self-hosted. Dedicated and Private Cloud use the same Platform
architecture and differ primarily by `single-tenant` versus `multi-tenant`
configuration; neither name implies a particular node count. See the normative
[deployment contract](docs/architecture/deployment-mode-contract.md).

## Quick start from source

Requirements: Node.js 22+, pnpm 11.3.0, and a Chromium-family browser for browser
acceptance tests.

```bash
git clone https://github.com/xingsy97/akernel.git
cd akernel
corepack enable
corepack prepare pnpm@11.3.0 --activate
pnpm install --frozen-lockfile
pnpm run build
```

Start the development Host and Dashboard in separate terminals:

```bash
ANTHROPIC_API_KEY=<provider-key> pnpm host:dev
```

```bash
pnpm dashboard:dev
```

Open the URL printed by Vite. To use File, Git, Shell, and Terminal tools, start
an Executor from a workspace directory in a third terminal:

```bash
pnpm --filter @agent-kernel/executor dev -- --host http://localhost:3000 --sandbox-root <workspace-root>
```

`OPENAI_API_KEY` may be used instead of `ANTHROPIC_API_KEY`. Provider endpoints
and model selection can also be configured in Dashboard Settings. Never commit
provider credentials or local configuration.

## Portable release

Once a release candidate is published, download both the asset and checksums
from the same GitHub Release, verify it, then run it:

```bash
gh release download v0.2.0-rc.1 --repo xingsy97/akernel \
  --pattern bundle-dashboard-with-runtime.cjs --pattern SHA256SUMS
sha256sum --ignore-missing --check SHA256SUMS
ANTHROPIC_API_KEY=<provider-key> node bundle-dashboard-with-runtime.cjs --port 3000
```

Native Portable assets use names such as `agent-kernel-host-linux-x64`. A
release is not considered available for a platform until that exact artifact is
present and its clean-machine acceptance gate has passed.

## Platform deployment

Dedicated release bundles include the source-free `runlab-dedicated` operator for
install, status, upgrade, rollback, backup, restore, and data-preserving uninstall.
Its contract is documented in the
[Dedicated operator CLI runbook](docs/operations/dedicated-operator-cli.md). Operators should also follow the
[Dedicated runbook](docs/operations/dedicated-platform-systemd-external-agent-handoff.md)
and must perform cutover from a control process independent of the Runtime being
replaced.

Private Cloud releases use digest-pinned multi-architecture Runtime, Ingress, and
Dashboard images plus Linux x64/arm64 Compose bundles. The native
`runlab-private-cloud` operator provides install, status, full or Dashboard-only
upgrade, rollback, consistent backup/restore, and data-preserving uninstall without
a source checkout or Node.js. Its normative contract is the
[Private Cloud release runbook](docs/operations/private-cloud-release.md); the
repository-local workflow under [`deploy/private-cloud`](deploy/private-cloud/README.md)
is for development and acceptance.

## Architecture

```text
Browser -> Dashboard / Stable Ingress -> Runtime Host -> model provider
                                      |
                                      +-> outbound-connected Executor fleet
                                          File / Git / Shell / Terminal / Artifacts

Runtime Host -> append-only Session log -> pure Kernel reducer -> effects
```

The repository also contains a separately deployable evaluation platform and RL
integration work. Evaluation orchestration does not read product Session artifacts
as an implicit data source.

## Repository layout

- `packages/kernel`: pure reducer and replay contracts
- `packages/host`: Runtime, persistence, provider adapters, HTTP and Socket.IO
- `packages/executor`: outbound tool runner and service lifecycle
- `packages/dashboard`: responsive product UI and PWA
- `packages/eval-*`, `adapters`, `task-packs`: standalone evaluation platform
- `deploy`: Dedicated, Private Cloud, Identity, and evaluation deployment assets
- `docs`: normative architecture, protocols, design, and operations
- `scripts`: build, verification, release, deployment, security, and acceptance tooling

Start with the [documentation index](docs/README.md),
[contribution guide](CONTRIBUTING.md), and [security policy](SECURITY.md).

## Development gates

Use targeted package tests while changing code, then run the applicable integrated
gate before submitting or releasing:

```bash
pnpm run typecheck
pnpm run test:fast
pnpm run privacy:check
pnpm run verify:licenses
```

Release candidates additionally require full-history privacy, extended tests,
release installation, supply-chain, clean-system, Browser, Executor, rollback, and
backup/restore evidence defined in the
[public release readiness runbook](docs/operations/public-release-readiness.md).

## License

Agent RunLab source is available under the [MIT License](LICENSE). Third-party
components remain governed by their own licenses and notices.
