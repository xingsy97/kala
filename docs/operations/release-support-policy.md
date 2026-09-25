# Release and support policy

Kala is pre-1.0 software. The supported public channel is the newest
GitHub Release candidate identified by one product tag, currently
`v0.2.0-rc.13`. A release candidate remains a draft until the three-platform
Portable install/reinstall matrix and the release asset and image security gates
in `public-release-readiness.md` have attached evidence. Source from
an arbitrary commit, nightly artifacts, mutable container tags, and development
Compose overrides are unsupported.

Security fixes are applied to the newest release candidate. There is no parallel
maintenance branch or guaranteed data/protocol compatibility between pre-1.0
release candidates. An upgrade that changes persisted state must ship its migration,
backup/restore procedure, and rollback boundary in the same release. The previous
immutable Dedicated or Private Cloud release is retained for the documented rollback
window; Portable users retain the previous verified executable themselves.

The supported install matrix for this bootstrap RC is Portable on Linux x64 and
macOS x64/arm64, only after each native asset has passed a clean install and
same-version reinstall on its matching runner. Linux arm64 native binaries and
Windows binaries or installers do not ship in this RC. Linux arm64 installer
platform detection remains available for future releases, but native acceptance
has not passed. Public standalone Executor installers fail closed
without release signature verification. A one-time install issued by an
authenticated Host verifies the Host-served SHA-256 index, but trusts that Host
and its transport; it does not independently verify a release signature.
Do not enable the unsigned override for downloads from untrusted hosts.
Dedicated bundles
and Private Cloud images are packaged and scanned as preview artifacts; their
upgrade, rollback, backup/restore, tenant isolation, and systemd/Compose
lifecycles are **not** certified without independent clean-environment evidence.
Do not represent these previews as supported deployments. Browser support targets
the current and previous major Chromium releases.

Report vulnerabilities privately through `SECURITY.md`. General defects use the
public issue templates and must contain synthetic, redacted evidence. Release assets use the repository, issue tracker, and documentation links
embedded in their metadata; no private installation data is accepted as public evidence.
