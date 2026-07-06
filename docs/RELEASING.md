# Releasing

Packages are published independently on tag push:

| Tag pattern      | Publishes                                                  |
| ---------------- | ---------------------------------------------------------- |
| `kernel-v*`      | `@agent-kernel/kernel`                                     |
| `host-v*`        | `@agent-kernel/host` (+ `shared`, `kernel` if newer)       |
| `executor-v*`    | `@agent-kernel/executor` (+ `shared`, `kernel` if newer)   |

`@agent-kernel/shared` is not tag-driven directly; it rides along with `host`
and `executor` because it is a transitive dep. `@agent-kernel/dashboard` is
not published  -  it is only served by the host as a static bundle.

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
pnpm run publish:all       # kernel  -  host  -  executor in order
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
| `agent-kernel-host.cjs`                | Single-file Node 22 executable for the host CLI. |
| `agent-kernel-executor.cjs`            | Single-file Node 22 executable for the executor. |
| `agent-kernel-dashboard-dist.tar.gz`   | Static dashboard bundle served by the host.      |
| `manifest.json`                        | Asset manifest and runtime notes.                |
| `SHA256SUMS`                           | Checksums for release verification.              |

Tag behavior:

| Tag pattern       | Uploaded assets                                      |
| ----------------- | ---------------------------------------------------- |
| `v*`              | Host, executor, dashboard tarball, manifest, sums.   |
| `host-v*`         | Host, dashboard tarball, manifest, sums.             |
| `executor-v*`     | Executor, manifest, sums.                            |
| `dashboard-v*`    | Dashboard tarball, manifest, sums.                   |

These are single-file Node executables, not native binaries. They require
Node.js 22 or newer. To serve the dashboard with the host asset, unpack the
dashboard tarball and set `DASHBOARD_DIR`:

```bash
tar -xzf agent-kernel-dashboard-dist.tar.gz -C /tmp/agent-kernel-dashboard
DASHBOARD_DIR=/tmp/agent-kernel-dashboard node agent-kernel-host.cjs
HOST_URL=http://localhost:3000 node agent-kernel-executor.cjs
```

Local dry run:

```bash
pnpm run build:release-assets
pnpm run verify:release-assets
pnpm run build:release-assets -- --component host
pnpm run verify:release-assets
ls -lh release/
(cd release && shasum -a 256 -c SHA256SUMS)
```

The CI workflow also builds and verifies the default release asset set on every
push / pull request, so broken executable bundles are caught before a tag is
pushed. The release workflow uses `GITHUB_TOKEN` with `contents: write`; no
extra GitHub secret is required for uploading GitHub Release assets.
