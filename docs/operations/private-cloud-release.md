# Private Cloud public release and operator contract

**Status:** normative

Private Cloud is the multi-tenant configuration of the self-hosted Platform. Its
public distribution is a signed, versioned Compose bundle plus three independent
multi-architecture OCI images: Runtime, Stable Ingress, and Dashboard. An operator
machine needs Docker Engine with Compose v2, the downloaded bundle, deployment
configuration, and private secrets. It never needs Git, Node.js, pnpm, or source.

## Immutable release bundle

Every bundle contains `compose.yaml`, supported storage and edge overrides,
`deployment.json`, environment examples, `image-lock.json`, `manifest.json`, and
the matching Linux x64 or arm64 `runlab-private-cloud` native executable (the
repository `.mjs` entry remains a development/test path). The production Compose model contains
no `build:` key. Every image, including infrastructure and one-shot jobs, is a
registry name followed by an exact `@sha256:` digest. `image-lock.json` binds the
product version, revision, and Runtime, Ingress, and Dashboard digests. The bundle
manifest binds every shipped file by size and SHA-256.

`compose.dev.yaml` is a repository-only override for source builds and acceptance.
It is not a release asset and is never accepted by the public operator.

## Supported lifecycle

```text
runlab-private-cloud install --bundle DIR --config-dir DIR
runlab-private-cloud status
runlab-private-cloud upgrade --bundle DIR
runlab-private-cloud upgrade-dashboard --bundle DIR
runlab-private-cloud rollback
runlab-private-cloud backup --output EMPTY_PERSISTENT_DIR
runlab-private-cloud restore --backup DIR --confirm RESTORE:<backup-id>
runlab-private-cloud uninstall --confirm UNINSTALL:<installation-id>
```

The operator owns a versioned installation record, immutable copied releases, an
active image lock, one predecessor lock, and monotonic atomic operation receipts.
Install and upgrade pull by digest before mutation. A complete upgrade replaces
application services and keeps the prior image lock for one-step rollback. A
Dashboard-only upgrade replaces only `dashboard` and proves the Runtime and
Ingress container identities did not change. Rollback uses the persisted
predecessor, never a mutable tag or caller-supplied guess.

Backup records the exact active image lock and Compose project, stops application
writes, dumps PostgreSQL, archives persistent volumes, hashes each streamed artifact,
and writes the manifest last before restoring service. Restore verifies every hash
before stopping services. Lifecycle receipts use
an explicit transition graph; invalid or non-monotonic transitions fail closed.
Uninstall removes containers and operator-owned installation metadata only after an
installation-specific confirmation. Volumes, configuration, secrets, releases,
receipts, and backups are retained by default.

## Independent Dashboard lifecycle

Dashboard has its own image digest and service. `upgrade-dashboard` may change only
that digest and container. Runtime and Ingress identities are checked before and
after the operation. Portable is the sole distribution where Dashboard assets and
Runtime share a binary lifecycle.

## Publishing and verification

Release CI builds `linux/amd64` and `linux/arm64` images, merges each component into
one manifest-list digest, signs those digests with keyless Sigstore identity, emits
OCI provenance and CycloneDX SBOMs, and then builds the Compose bundle from those
digests. The draft GitHub Release remains unpublished until clean install, tenant
isolation, full upgrade, Dashboard-only upgrade, rollback, backup/restore, Browser,
and Executor acceptance all pass.
