# Agent RunLab deployment profiles

The RunLab application and shared Identity service have independent Compose projects.
No credential values belong in Git; only `*.env.example` metadata files are tracked.

Profiles:

- `local`: loopback HTTP, Docker NFS-Ganesha storage.
- `cloudflare`: private deployment origins supplied through the ignored environment, Docker NFS-Ganesha.
- `acceptance`: local topology plus mock LLM.
- `local-volume`: development-only Docker local volume.
- `external-nfs`: Cloudflare profile with an operator-supplied NFS endpoint.

```bash
pnpm saas:secrets
RUNLAB_PROFILE=cloudflare pnpm saas:check
RUNLAB_PROFILE=cloudflare pnpm saas:deploy
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
Run `RUNLAB_PROFILE=cloudflare node scripts/saas-local/health-report.mjs` from monitoring.
Alert on non-zero exit, less than 5 GiB free space, unhealthy containers, PostgreSQL backup
failure, or NFS health failure. Runtime egress is intentionally isolated on the `egress`
network; enforce destination-level policy at the host firewall or an egress proxy. Production
release automation should resolve mutable application image names to the IDs captured in the
ignored local release manifest before promotion.
