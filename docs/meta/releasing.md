# Releasing

Agent RunLab uses one product version and one Git tag across the monorepo.
`v0.2.0-rc.1`, for example, identifies the source revision, npm workspace
packages, Portable assets, Dedicated bundle, Dashboard manifest, and Private
Cloud images produced by that release. Protocol and persisted-schema versions
remain independent compatibility contracts.

## Version gate

All workspace `package.json` files use the root product version. Public packages
must declare MIT and cannot depend on private workspace packages. Verify before
cutting a tag:

```bash
pnpm run verify:version -- --tag v0.2.0-rc.1
```

The release asset verifier repeats the check against `release/manifest.json`.
There are no component-specific product tags. Independent Dashboard updates use
the Dashboard Supervisor generation/release protocol and retain the product
version of the source release from which they were built.

## npm packages

The `Publish npm workspaces` workflow runs only on a matching `v*` tag. It runs
privacy, license, build, type, and test gates, then publishes public workspace
packages in dependency order with npm provenance. Existing exact versions are
skipped, making a failed workflow resumable. Pre-release versions use the npm
`next` dist-tag; stable versions use `latest`.

The workflow requires the protected `npm` environment and `NPM_TOKEN`. A token
does not replace npm provenance: GitHub OIDC permission remains required.

## GitHub Release assets

The `GitHub Release Assets` workflow also accepts only the unified `v*` tag. Its
native matrix builds matching-runner Node SEA assets for Linux, macOS, and
Windows on x64 and arm64. Node SEA assets are never cross-compiled or relabeled.
The CJS job builds portable fallbacks, the Dashboard archive, Dedicated operator
assets, release notes, manifest, and checksums. The final job merges exact
artifacts and regenerates all metadata before publication.

Important assets include:

| Asset | Purpose |
|---|---|
| `bundle-dashboard-with-runtime.cjs` | Portable Runtime with embedded Dashboard |
| `agent-kernel-host-<os>-<arch>` | Native Portable Runtime |
| `agent-kernel-executor.cjs` | Node.js Executor fallback |
| `runlab-executor-<os>-<arch>` | Native Executor |
| `agent-runlab-runtime.cjs` | Platform Runtime without embedded Dashboard |
| `agent-kernel-dashboard-dist.tar.gz` | Independent Platform Dashboard |
| `run.sh` | Checksum-verifying Portable bootstrap |
| `manifest.json` and `SHA256SUMS` | Release identity and integrity |

The `.cjs` assets require Node.js 22+. `run.sh` prefers them when Node 22 is
available and otherwise selects a matching native binary. Manual downloads must
verify `SHA256SUMS` before execution.

## Release sequence

1. Update `CHANGELOG.md` and set the intended root/workspace version.
2. Run `verify:version`, privacy history, licenses, build/typecheck/tests, and
   clean-environment acceptance from the public release readiness runbook.
3. Commit from a clean worktree and create the matching annotated `v*` tag.
4. Let npm and GitHub workflows build from the tag; do not upload local binaries.
5. Keep the GitHub Release as a draft until signatures, provenance, SBOMs, all
   native targets, clean installs, upgrades, rollbacks, and restore evidence pass.
6. Publish the draft and move the npm stable dist-tag only for a stable release.

The complete go/no-go criteria are in
[`../operations/public-release-readiness.md`](../operations/public-release-readiness.md).
