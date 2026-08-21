# Release and support policy

Agent RunLab is pre-1.0 software. The supported public channel is the newest
GitHub/npm release candidate identified by one product tag, currently
`v0.2.0-rc.1`. A release candidate remains a draft until every platform and
deployment gate in `public-release-readiness.md` has attached evidence. Source from
an arbitrary commit, nightly artifacts, mutable container tags, and development
Compose overrides are unsupported.

Security fixes are applied to the newest release candidate. There is no parallel
maintenance branch or guaranteed data/protocol compatibility between pre-1.0
release candidates. An upgrade that changes persisted state must ship its migration,
backup/restore procedure, and rollback boundary in the same release. The previous
immutable Dedicated or Private Cloud release is retained for the documented rollback
window; Portable users retain the previous verified executable themselves.

Supported environments are the exact artifact matrix published by Release CI:
Portable on Linux, macOS, and Windows x64/arm64; Dedicated on systemd Linux; and
Private Cloud on Linux x64/arm64 with Docker Engine and Compose v2. A platform is not
supported merely because source compilation succeeds. Browser support targets the
current and previous major Chromium releases. Executor compatibility is verified by
the release acceptance matrix.

Report vulnerabilities privately through `SECURITY.md`. General defects use the
public issue templates and must contain synthetic, redacted evidence. Release assets
and npm packages use the repository, issue tracker, and documentation links embedded
in their metadata; no private installation data is accepted as public evidence.
