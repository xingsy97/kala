# Private Cloud public release and operator contract

**Status:** normative

New deployments should follow the [signed-release first-install guide](./private-cloud-first-install.md)
for the complete operator, identity, first owner, Executor and backup journey.

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
digests. The tag workflow still publishes the three images and uploads signed
Compose bundles to the GitHub Release; publishing alone is **not** proof that a
specific bundle passed production acceptance. Do not promise a production-ready
Private Cloud release without a successful clean acceptance artifact for its exact
archive SHA-256 and commit.

The optional `clean-compose-acceptance` job uses the `linux-x64` signed bundle
transferred from the same `bundle` job, and verifies its Sigstore identity. It
fetches a previously released, signed predecessor bundle, checks both bundles'
embedded revisions against their tags, then installs into an isolated Compose
project, tests two tenants, the Browser and Executor, mTLS, Unit quotas, restart
recovery, Dashboard-only/full upgrade, rollback, and backup/restore. On success it
uploads a minimal digest-bound `rc-evidence.json` Actions artifact. A skipped,
queued, or failed job produces **no passing evidence**; the existing optional
product E2E on a preinstalled deployment is not a substitute.

To enable this job, register a dedicated self-hosted runner with labels
`self-hosted`, `linux`, `x64`, `private-cloud-clean` and Docker Compose, `gh`, a
working Chromium (`CHROME_PATH`, default `/snap/bin/chromium`), access to GHCR and
the test IdP, and a free port 13001. Configure repository variable
`KALA_PRIVATE_CLOUD_RUNNER_ENABLED=true`, variable
`KALA_RC_PRIVATE_CLOUD_CONFIG_TEMPLATE` pointing to the local private config
directory (`deployment.env`, provider catalog, secrets), and variable
`KALA_PRIVATE_CLOUD_PREDECESSOR_TAG` pointing to the previously signed release;
manual dispatch may instead provide `predecessor_tag`. Configure secrets
`PRIVATE_CLOUD_TEST_ALICE_EMAIL`, `PRIVATE_CLOUD_TEST_ALICE_PASSWORD`,
`PRIVATE_CLOUD_TEST_ALICE_OIDC_ISSUER`, `PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT`,
`PRIVATE_CLOUD_TEST_BOB_EMAIL`, `PRIVATE_CLOUD_TEST_BOB_PASSWORD`,
`PRIVATE_CLOUD_TEST_BOB_OIDC_ISSUER`, and `PRIVATE_CLOUD_TEST_BOB_OIDC_SUBJECT`.
Obtain each exact issuer and `sub` from that independent test identity's verified
ID token or IdP administrative record; never derive or guess `sub` from email.
After installing the predecessor bundle, the clean acceptance uses the current
worktree Operator to provision each identity as owner of a different Organization
before either login. This exercises the new command without replacing or silently
initializing the predecessor deployment as the candidate version. The runner must
be exclusive while acceptance runs; do not reuse a customer's
installation or rely on a dirty persistent deployment. The GitHub release upload
is not gated on this optional job: check its evidence before customer delivery.
