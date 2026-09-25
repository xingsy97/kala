# Kala Private Cloud

Public installations use the versioned release bundle and its `kala-private-cloud`
operator. See `docs/operations/private-cloud-release.md`. No source checkout or
local application build is part of the supported production workflow.

The commands below are repository development and acceptance workflows only. They
add `compose.dev.yaml`, which supplies local source builds over the production
topology.

The RunLab application and shared Identity service have independent Compose projects.
No credential values belong in Git; only `*.env.example` metadata files are tracked.
Start and verify the Identity project first; Private Cloud consumes it only as an OIDC client.

Profiles:

- `local`: loopback HTTP, Docker NFS-Ganesha storage.
- `cloudflare`: private deployment origins supplied through the ignored environment, Docker NFS-Ganesha.
- `acceptance`: local topology plus mock LLM.
- `local-volume`: development-only Docker local volume.
- `external-nfs`: Cloudflare profile with an operator-supplied NFS endpoint.

```bash
docker compose --env-file deploy/identity/.secrets/deployment.env \
  -f deploy/identity/compose.yaml up -d --wait
pnpm private-cloud:secrets
RUNLAB_PROFILE=cloudflare pnpm private-cloud:check
RUNLAB_PROFILE=cloudflare pnpm private-cloud:deploy
```

The Platform Dashboard is a separate immutable container image behind Runtime Ingress. A
Dashboard-only release rebuilds and replaces only `dashboard`; it does not restart
`runtime-host`, change Unit ownership, interrupt Executor sockets, or run Session
continuation. Runtime and Dashboard image identities must both be captured in the private
release manifest. Portable remains the sole distribution that embeds Dashboard assets in
the Runtime executable.

```bash
RUNLAB_PROFILE=cloudflare pnpm private-cloud:deploy-dashboard
```

Cloudflare Tunnel routes:

```yaml
ingress:
  - hostname: <runlab-domain>
    service: http://127.0.0.1:13001
  - hostname: <identity-domain>
    service: http://127.0.0.1:13002
  - service: http_status:404
```

Do not put Cloudflare credentials, OIDC secrets, API keys, passwords, `.env` files, backups,
or generated release manifests into Git. Public hostnames in profile files are not secrets.
The default production storage remains the NFS server in the same Docker Compose project.

## Operational hardening

All long-running services use bounded `json-file` logs and drop Linux capabilities.
Run `RUNLAB_PROFILE=cloudflare node scripts/private-cloud-local/health-report.mjs` from monitoring.
Alert on non-zero exit, less than 5 GiB free space, unhealthy containers, PostgreSQL backup
failure, or NFS health failure. Runtime egress is intentionally isolated on the `egress`
network; enforce destination-level policy at the host firewall or an egress proxy. Production
release automation should resolve mutable application image names to the IDs captured in the
ignored local release manifest before promotion.
