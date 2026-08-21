# Public repository and release readiness

**Status:** normative; implementation in progress

**Target:** `v0.2.0-rc.1`

**Scope:** public source repository, npm packages, Portable artifacts, Dedicated
release bundle, Private Cloud images/bundle, and release evidence

## 1. Release contract

One product release uses one SemVer version and one tag, such as
`v0.2.0-rc.1`. The root package, publishable workspace packages, manifests,
Dashboard metadata, container labels, release notes, and npm packages must agree.
Protocol and persisted-schema versions are independent compatibility contracts and
must not be changed merely to match the product version. Component-specific tags
are not part of the target release model.

The release is built from a clean, signed or protected Git revision. Generated
assets record the exact revision and content digest. Publishing is allowed only
after privacy, license, build, test, install, upgrade, rollback, backup/restore,
browser, Executor, and clean-environment acceptance gates pass.

## 2. User-facing distributions

| Variant | Distribution | Required user workflow | Dashboard lifecycle |
|---|---|---|---|
| Portable | one CJS or one OS/architecture native executable | download, verify, run | embedded and upgraded with Runtime |
| Dedicated | signed Platform release bundle and systemd operator CLI | install, status, upgrade, rollback, backup, restore, uninstall | independent immutable release |
| Private Cloud | signed multi-architecture images plus a versioned Compose bundle | configure secrets, preflight, install/upgrade/rollback with no source checkout | independent image |

Every variant is self-hosted. Dedicated is Platform with `single-tenant`; Private
Cloud is the same Platform architecture with `multi-tenant`.

## 3. Required gates

### Repository and governance

- [x] MIT project license.
- [x] Security policy, code of conduct, contribution guide, issue/PR templates,
  CODEOWNERS, and changelog.
- [x] Snapshot and complete-history privacy scanning.
- [x] Production dependency license allowlist with exact review for non-SPDX metadata.
- [ ] Public API/package documentation matches shipped package contents.
- [ ] Repository metadata, package links, and release support policy are finalized.

### Version and supply chain

- [x] One product version is enforced across packages and artifacts.
- [x] Linux, macOS, and Windows x64/arm64 Portable build jobs exist on matching
  runners where the
  runtime toolchain supports them.
- [ ] Windows installer and uninstall path are verified.
- [x] GitHub release assets have a keyless checksum signature and GitHub build
  provenance workflow; container signing remains pending.
- [x] CycloneDX SBOMs and third-party notices ship with GitHub release assets.
- [ ] Vulnerability scanning uses an explicit severity/exception policy.

### Operator experience

- [x] Dedicated provides supported install, status, upgrade, rollback, backup,
  restore, and uninstall commands without requiring a source checkout.
- [ ] Private Cloud ships digest-pinned multi-architecture images and a versioned
  Compose bundle that does not build application source on the operator machine.
- [x] Destructive commands identify bounded targets, require explicit intent, and
  preserve recoverable data by default.

The normative Dedicated command and recovery contract is
[`dedicated-operator-cli.md`](dedicated-operator-cli.md).

### Acceptance

- [ ] Portable passes clean Linux, macOS, and Windows install/run/upgrade checks.
- [ ] Dedicated passes clean systemd install, graceful cutover, rollback, reboot,
  backup/restore, Browser, Executor, and self-deployment checks.
- [ ] Private Cloud passes clean Compose install, tenant isolation, image upgrade,
  Dashboard-only update, rollback, backup/restore, and Executor checks.
- [ ] Release candidates are drafts until all required evidence is attached.

## 4. Evidence and privacy

Release evidence records revision, version, asset/image digest, test result, target
platform, operation phase, and rollback result. It must not contain real domains,
IPs, credentials, private filesystem paths, Session content, receipts from a private
installation, or screenshots with private data. Generated local evidence stays
outside Git unless it is deterministic, redacted, reviewed, and explicitly approved.

## 5. Stop conditions

Do not publish when a required platform has no verified artifact, a digest/signature
cannot be reproduced, an unknown license remains, history privacy scanning fails, a
clean install needs repository source unexpectedly, or recovery evidence is missing.
Partial packaging or a successful Dashboard deployment is not release readiness.
