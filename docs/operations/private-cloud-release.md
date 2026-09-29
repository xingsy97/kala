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
the matching Linux x64 or arm64 `kala-private-cloud` native executable (the
repository `.mjs` entry remains a development/test path). The production Compose model contains
no `build:` key. Every image, including infrastructure and one-shot jobs, is a
registry name followed by an exact `@sha256:` digest. `image-lock.json` binds the
product version, revision, and Runtime, Ingress, and Dashboard digests. The bundle
manifest binds every shipped file by size and SHA-256.

`compose.dev.yaml` is a repository-only override for source builds and acceptance.
It is not a release asset and is never accepted by the public operator.

## Supported lifecycle

```text
kala-private-cloud install --bundle DIR --config-dir DIR
kala-private-cloud status
kala-private-cloud upgrade --bundle DIR
kala-private-cloud upgrade-dashboard --bundle DIR
kala-private-cloud rollback
kala-private-cloud backup --output EMPTY_PERSISTENT_DIR
kala-private-cloud restore --backup DIR --confirm RESTORE:<backup-id>
kala-private-cloud uninstall --confirm UNINSTALL:<installation-id>
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

An individual Runtime Unit may also be exported for operator-controlled transfer.
The export contains only that Unit's directory and a manifest binding its Unit ID,
source revision, size, and SHA-256. Restore requires `runtime-host` to be stopped,
validates every archive path, and refuses to merge into or overwrite an existing
Unit. Export material must be encrypted before it leaves the trusted host.

## Runtime isolation gates

The public Gateway reaches Runtime only over TLS 1.3 with mutual certificate
authentication. Server, Gateway-client, and health-probe certificates are signed by
an installation-local CA and mounted only into the services that require them. The
application ingress secret remains mandatory as defense in depth.

Every Runtime Unit is admitted through a process-local resource governor. Concurrent
turns, durable queued messages, and artifact bytes have independent per-Unit limits;
usage is reconciled from durable queue and artifact state after loading a Unit.
Exhaustion fails closed without partially accepting a message or artifact.

Release acceptance must prove all of the following before promotion:

- a client without the internal CA-signed certificate cannot reach Runtime;
- Unit limits reject excess work without affecting a second Unit;
- Runtime restart preserves accepted queues, DAG leases, and Session cursors;
- a full backup restores in disposable volumes and a Unit export restores without
  path traversal or overwrite;
- authenticated browser and Executor journeys remain functional under the supported
  concurrency load.

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
