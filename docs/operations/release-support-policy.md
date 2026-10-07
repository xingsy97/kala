# Release and support policy

Kala is pre-1.0 software. The supported public channel is the newest stable
GitHub Release identified by one product tag, currently `v0.2.0`. A release
remains a draft until the three-platform
Portable install/reinstall matrix and the release asset and image security gates
in `public-release-readiness.md` have attached evidence. Source from
an arbitrary commit, nightly artifacts, mutable container tags, and development
Compose overrides are unsupported.

Security fixes are applied to the newest stable release. There is no parallel
maintenance branch or guaranteed data/protocol compatibility between pre-1.0
releases. An upgrade that changes persisted state must ship its migration,
backup/restore procedure, and rollback boundary in the same release. The previous
immutable Dedicated or Private Cloud release is retained for the documented rollback
window; Portable users retain the previous verified executable themselves.

The supported install matrix for `v0.2.0` is Portable on Linux x64 and
macOS x64/arm64, only after each native asset has passed a clean install and
same-version reinstall on its matching runner. Linux arm64 native binaries and
Windows binaries or installers do not ship in this release. Linux arm64 installer
platform detection remains available for future releases, but native acceptance
has not passed. Public standalone Executor installers fail closed
without release signature verification. A one-time install issued by an
authenticated Host verifies the Host-served SHA-256 index, but trusts that Host
and its transport; it does not independently verify a release signature.
Do not enable the unsigned override for downloads from untrusted hosts.
Dedicated bundles and Private Cloud images are built and published through their
normal signed distribution workflows. Publishing is **not** certification:
upgrade, rollback, backup/restore, tenant isolation, and systemd/Compose
lifecycles require independent clean-environment evidence tied to the exact
release. Do not promise production support for a Dedicated or Private Cloud
candidate without that evidence. See the [Private Cloud first-install guide](./private-cloud-first-install.md)
for the operator-assisted onboarding path. Browser support targets
the current and previous major Chromium releases.

## Unreleased v0.3.0-beta.1 candidate policy

The beta candidate is not yet a supported public release. Its proposed default
asset contract is Linux x64 and macOS x64/arm64 OS-native Executor plus Node.js
22+ CJS Portable Host and Dedicated components. Host and Dedicated
self-contained native binaries are only manual qualification artifacts, not
part of the signed default inventory. The Private Cloud signed bundle defaults
to a JS Operator (Node.js 22+ on the installation host) and single-host
`local-volume` storage. Local NFS requires an explicit experimental choice;
there is no full-stack NFS acceptance evidence. Windows x64 Portable Host CJS
and OS-native Executor with ConPTY are separate pending runner gates and must
not be advertised as shipped until both their actual assets and end-to-end
results pass. For the candidate, Windows Host is **Node.js 22+ CJS**, not an
OS-native Host `.exe`: its matching `kala-copilot-runtime-win32-x64` and
`kala-copilot-runtime-node-win32-x64.node` must be distributed alongside it.
Windows Executor is the default OS-native `kala-executor-win32-x64.exe`,
with the matching `node-pty-win32-x64.tar.gz` ConPTY companion and
`install-executor.ps1`. A standalone Host CJS download alone does **not**
contain the signed Windows Executor/ConPTY installer: Host-mediated Windows
installation stays disabled until the Host can serve these adjacent assets
with matching SHA256SUMS entries from the exact release. Acceptance must
cover both a fresh Windows Host and the native Executor temporary/service
terminal lifecycles using the downloaded release assets, not merely a
source checkout.

The Linux x64 Portable OCI image has not yet been built, signed or accepted
from an immutable GHCR digest in an isolated VM. None of these candidate
policies retroactively alters the `v0.2.0` support claim above.

Report vulnerabilities privately through `SECURITY.md`. General defects use the
public issue templates and must contain synthetic, redacted evidence. Release assets use the repository, issue tracker, and documentation links
embedded in their metadata; no private installation data is accepted as public evidence.
