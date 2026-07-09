# Releasing

Packages are published independently on tag push:

| Tag pattern      | Publishes                                                  |
| ---------------- | ---------------------------------------------------------- |
| `kernel-v*`      | `@agent-kernel/kernel`                                     |
| `host-v*`        | `@agent-kernel/host` (+ `shared`, `kernel` if newer)       |
| `executor-v*`    | `@agent-kernel/executor` (+ `shared`, `kernel` if newer)   |

`@agent-kernel/shared` is not tag-driven directly; it rides along with `host`
and `executor` because it is a transitive dep. `@agent-kernel/dashboard` is
not published — it is only served by the host as a static bundle.

## Cutting a release

```bash
# 1. Bump the version in the target package.json (and shared/kernel if their
#    surface changed).
pnpm --filter @agent-kernel/host exec npm version 0.2.0

# 2. Commit + tag with the matching name.
git commit -am "chore: release host 0.2.0"
git tag host-v0.2.0
git push origin main --tags
```

The `Publish to npm` workflow runs, builds, tests, verifies the tag version
matches `package.json`, and publishes with npm provenance.

Requires repo secret `NPM_TOKEN` scoped to `@agent-kernel`.

## Local dry run

```bash
pnpm run publish:kernel    # publishes kernel only
pnpm run publish:host      # publishes host (assumes shared+kernel already up)
pnpm run publish:executor  # publishes executor
pnpm run publish:all       # kernel → host → executor in order
```

Each calls the package's `publish:npm` script, which rebuilds first and then
runs `pnpm publish --access public --no-git-checks`.

## GitHub Release assets

Codex-style direct downloads are produced by the `GitHub Release Assets`
workflow. It runs on aggregate tags matching `v*` and component tags matching
`host-v*`, `executor-v*`, or `dashboard-v*`. It can also be run manually with a
target tag and component. The workflow builds, tests, typechecks, bundles
release assets, verifies executable bits / checksums / CLI smoke behavior, and
uploads them to the GitHub Release for that tag.

Current assets:

| Asset                                  | Description                                      |
| -------------------------------------- | ------------------------------------------------ |
| `agent-kernel-host-<os>-<arch>`        | OS-native host binary. Current release workflow builds Linux x64, macOS x64, and Windows x64. |
| `agent-kernel-executor-<os>-<arch>`    | OS-native executor binary. Current release workflow builds Linux x64, macOS x64, and Windows x64. |
| `agent-kernel-host.cjs`                | Node.js 22 fallback asset for the host CLI.      |
| `agent-kernel-executor.cjs`            | Node.js 22 fallback asset for the executor.      |
| `agent-kernel-dashboard-dist.tar.gz`   | Static dashboard bundle served by the host.      |
| `run.sh`                               | Wget-only bash bootstrap that downloads checksums, uses compact `.cjs` assets when Node.js 22+ is available, and falls back to native binaries otherwise. |
| `RELEASE_NOTES.md`                     | Generated GitHub Release body with quick-start commands, port configuration, runtime selection, checksum verification, and asset list. |
| `manifest.json`                        | Asset manifest and runtime notes.                |
| `SHA256SUMS`                           | Checksums for release verification.              |

Tag behavior:

| Tag pattern       | Uploaded assets                                      |
| ----------------- | ---------------------------------------------------- |
| `v*`              | Host, executor, dashboard tarball, unified bootstrap, release notes, manifest, sums. |
| `host-v*`         | Host, dashboard tarball, unified bootstrap defaulting to host, release notes, manifest, sums. |
| `executor-v*`     | Executor, unified bootstrap defaulting to executor, release notes, manifest, sums. |
| `dashboard-v*`    | Dashboard tarball, release notes, manifest, sums.    |

Host and executor releases use automatic runtime selection. The default path is
the compact `.cjs` asset when Node.js 22+ is already installed; the native binary
is the zero-prerequisite fallback when Node is missing or too old. The workflow
is two-phase for speed. The `cjs-release` job builds, verifies, and publishes the
Node.js fallback assets plus dashboard bundle as soon as the normal build / test
gate passes. In parallel, the `native-assets` matrix builds native Node SEA
binaries on matching platform runners. Node SEA assets are not cross-compiled:
the build script rejects a requested native target that does not match the
current runner platform / architecture, so the release cannot accidentally
publish a mislabeled binary. After both phases are available, `native-release`
merges the current fallback artifact and current native artifacts, regenerates
the manifest / release notes / checksums, and uploads the refreshed release
assets. This makes the release usable before the slow native matrix has finished
while still ending in one coherent GitHub Release.

The `.cjs` files remain as fallback assets for unsupported platforms or manual
debugging; they require Node.js 22 or newer.

The recommended release entrypoint is the bash bootstrap, not piping an asset
directly into `node`. The bootstrap downloads `SHA256SUMS`, detects the current
OS / architecture, and selects a runtime:

- `AGENT_KERNEL_RUNTIME=auto` (default): use `.cjs` when Node.js 22+ is present;
  otherwise use a matching native binary when available.
- `AGENT_KERNEL_RUNTIME=cjs`: require the compact `.cjs` asset and Node.js 22+.
- `AGENT_KERNEL_RUNTIME=native`: require the matching native binary.

Example one-line commands for a full release tag:

```bash
wget -qO- https://github.com/<owner>/<repo>/releases/download/v0.2.0/run.sh | COMPONENT=host bash
wget -qO- https://github.com/<owner>/<repo>/releases/download/v0.2.0/run.sh | COMPONENT=executor HOST_URL=http://localhost:3000 bash
```

The host also accepts `--port <port>` directly when launching an unpacked or
downloaded host asset. If the selected port is already occupied, startup fails
with a clear message telling the operator to stop the existing process or choose
a free port with `HOST_PORT=<free-port>` or `--port <free-port>`.

Verify downloaded assets before manual execution:

```bash
wget -q https://github.com/<owner>/<repo>/releases/download/v0.2.0/SHA256SUMS
wget -q https://github.com/<owner>/<repo>/releases/download/v0.2.0/agent-kernel-executor-linux-x64
sha256sum -c SHA256SUMS --ignore-missing
```

The dashboard's Connect Workspace dialog does not hard-code a GitHub repository.
It reads `release.bootstrapBaseUrl` from `GET /settings`. Released hosts get a
GitHub Release URL from `AGENT_KERNEL_RELEASE_BASE_URL` or
`AGENT_KERNEL_UPDATE_REPO` / `AGENT_KERNEL_RELEASE_TAG`; local development falls
back to `http://localhost:<HOST_PORT>/release-assets`, served from the local
`release/` directory.

To serve the dashboard manually with the host asset, unpack the dashboard
tarball and set `DASHBOARD_DIR`:

```bash
tar -xzf agent-kernel-dashboard-dist.tar.gz -C /tmp/agent-kernel-dashboard
DASHBOARD_DIR=/tmp/agent-kernel-dashboard ./agent-kernel-host-linux-x64
HOST_URL=http://localhost:3000 ./agent-kernel-executor-linux-x64
```

Executors launched from `run.sh` receive `AGENT_KERNEL_RELEASE_TAG` and
`AGENT_KERNEL_UPDATE_REPO`. The executor checks the latest GitHub Release at
startup and logs a reminder when a newer release is available. Automatic update
is opt-in:

```bash
wget -qO- https://github.com/<owner>/<repo>/releases/download/v0.2.0/run.sh | COMPONENT=executor HOST_URL=http://localhost:3000 AGENT_KERNEL_AUTO_UPDATE=1 bash
```

`--auto-update` is equivalent when launching a downloaded executor asset
directly. `--no-update-check` or `AGENT_KERNEL_NO_UPDATE_CHECK=1` disables the
startup reminder.

The release workflow uploads all generated assets and uses `RELEASE_NOTES.md`
as the GitHub Release body. Updating an existing release also replaces its
notes before uploading assets with `--clobber`.

Local dry run:

```bash
pnpm run build:release-assets
pnpm run verify:release-assets
pnpm run build:release-assets -- --component all --no-native
pnpm run build:release-assets -- --component executor --native-only --native-target linux-x64
pnpm run build:release-assets -- --component host
pnpm run verify:release-assets
ls -lh release/
(cd release && sha256sum -c SHA256SUMS --ignore-missing)
```

The CI workflow also builds and verifies the default release asset set on every
push / pull request, so broken executable bundles are caught before a tag is
pushed. The release workflow uses `GITHUB_TOKEN` with `contents: write`; no
extra GitHub secret is required for uploading GitHub Release assets.
