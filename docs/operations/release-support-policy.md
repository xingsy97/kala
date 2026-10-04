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

Report vulnerabilities privately through `SECURITY.md`. General defects use the
public issue templates and must contain synthetic, redacted evidence. Release assets use the repository, issue tracker, and documentation links
embedded in their metadata; no private installation data is accepted as public evidence.
