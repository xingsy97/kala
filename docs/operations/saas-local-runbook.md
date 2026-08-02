# SaaS Runbook

**Status:** single Docker Compose deployment contract
**Last verified:** 2026-08-01

## Scope

All SaaS components run in Docker through the single stack at `deploy/saas/local/compose.yaml`. This includes ZITADEL, PostgreSQL, Gateway, Runtime Host, and the NFS server. No SaaS daemon or data service is installed directly on the workstation or in LXD.

## Session storage

The stack contains:

- `nfs-server`: digest-pinned NFS-Ganesha userspace NFSv4 server;
- `nfs-session-data`: ordinary Docker Volume containing the authoritative Session bytes;
- `tenant-data`: NFS-backed Docker Volume mounted by Runtime Host at `/var/lib/agent-runlab`.

```mermaid
flowchart LR
  RH[Runtime Host container] --> TV[tenant-data NFS mount]
  TV --> NFS[NFS-Ganesha container]
  NFS --> BV[nfs-session-data Docker Volume]
```

Runtime Host therefore always uses real NFS semantics, while NFS-Ganesha and its backing data are managed by the same Docker stack. There is no external NFS configuration and no local-volume fallback for Runtime Host.

The NFS service is reachable only on the dedicated Docker network at `192.0.2.9:2049`; `127.0.0.1:12049` is exposed for local diagnostics. It is not exposed on the LAN or public ingress.

PostgreSQL remains the control-plane store. MinIO/S3 remains reserved for Artifacts, exports, support bundles, and immutable archives; it is not the active JSONL filesystem.

## Security boundary

- Gateway alone publishes the product origin at `127.0.0.1:13001`.
- PostgreSQL and Runtime Host publish no host ports.
- NFS publishes only a loopback diagnostic port and uses a dedicated Docker network.
- Runtime and NFS containers are capability-dropped, read-only, resource bounded, and use `no-new-privileges`.
- Docker socket is never mounted.
- Secrets use ignored `deploy/saas/.secrets/` files.
- A Runtime Unit/Session has one active writer lease although the filesystem is shared.

## Bootstrap and operation

```bash
pnpm saas:secrets
pnpm saas:validate
pnpm saas:up
```

`pnpm saas:up` creates and waits for NFS-Ganesha before Runtime Host's NFS-backed volume is used. `pnpm saas:down` removes containers and networks but preserves both Docker Volumes.

Configure a real Provider before non-acceptance use:

```bash
printf %s "$PROVIDER_API_KEY" > deploy/saas/.secrets/llm_api_key
chmod 600 deploy/saas/.secrets/llm_api_key
export SAAS_LLM_BASE_URL=https://provider.example/v1
export SAAS_LLM_MODEL=model-id
```

For protocol acceptance, add only the mock-Provider overlay; Session storage remains identical:

```bash
node scripts/saas-local/compose-with-nfs.mjs \
  -f deploy/saas/local/compose.acceptance.yaml \
  --profile acceptance up -d --build --wait
```

## Verification

```bash
pnpm saas:validate

docker inspect agent-runlab-saas-nfs-server-1 \
  --format '{{.State.Health.Status}}'

docker volume inspect \
  agent-runlab-saas_tenant-data \
  agent-runlab-saas_nfs-session-data
```

`tenant-data` must report:

```text
type=nfs
addr=192.0.2.9
nfsvers=4.2
device=:/
```

Validate content and POSIX operations from Runtime Host:

```bash
docker exec agent-runlab-saas-runtime-host-1 sh -lc '
  find /var/lib/agent-runlab -type f | wc -l
  probe=/var/lib/agent-runlab/.nfs-probe-$$
  printf probe > "$probe"
  sync
  mv "$probe" "$probe.renamed"
  rm "$probe.renamed"
'
```

## Migration from the former local tenant-data volume

1. Stop Runtime Host/Gateway writers.
2. Create a tar backup and SHA-256 digest of old `tenant-data`.
3. Restore it into `nfs-session-data`.
4. Compare every file hash.
5. Remove and recreate `tenant-data` with NFS options.
6. Start NFS, Runtime Host, and Gateway.
7. Verify file count, aggregate hash, ownership, write, `sync`, atomic rename, and Session recovery.
8. Keep the tar backup until acceptance finishes.

## Backup and restore

```bash
pnpm saas:backup
```

The backup contains PostgreSQL, a tar stream read through the active NFS mount, control data, and `storage.json` recording both Docker Volume names. Restore first into a disposable Docker Volume and compare hashes before replacing `nfs-session-data`.

## Operational requirements

- Monitor NFS container health, mount latency, capacity, inode use, and write errors.
- Test NFS container restart while Runtime Host is idle and during controlled writes.
- Back up `nfs-session-data` independently of container lifecycle.
- Never manipulate MinIO internal storage as a POSIX Session filesystem.
