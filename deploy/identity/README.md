# Shared Identity Stack

This Compose project owns the shared ZITADEL lifecycle independently of Kala.
Its canonical OIDC issuer comes from the ignored `IDENTITY_DOMAIN` deployment environment;
Cloudflare Tunnel should route that hostname to `http://127.0.0.1:13002`.

```yaml
ingress:
  - hostname: <identity-domain>
    service: http://127.0.0.1:13002
  - service: http_status:404
```

Start or update it with:

```bash
docker compose -f deploy/identity/compose.yaml up -d --wait
```

Before first start, provision Identity-owned secret files (do not commit them):

```bash
mkdir -p deploy/identity/.secrets
openssl rand -base64 48 > deploy/identity/.secrets/postgres_password
openssl rand -hex 16 | tr -d '\n' > deploy/identity/.secrets/zitadel_masterkey
chmod 600 deploy/identity/.secrets/*
```

The ZITADEL master key file must be **exactly 32 bytes** (no trailing newline) and readable by the container's non-root UID 1000; when creating files as root, set its owner to UID 1000 without widening the `0600` mode. The PostgreSQL password is URI-encoded when generating the private ZITADEL config, so base64 credentials containing `/` or `+` remain valid. Never rotate the master key in place without following ZITADEL's recovery procedure.

The Compose project owns its ZITADEL database, bootstrap, and configuration volumes under
canonical Identity names. Do not run `down -v`; back up PostgreSQL before upgrades. Other
applications should create their own OIDC application/client and use the configured issuer.

Kala is only an OIDC client of this stack. Its callback is
`https://<runlab-domain>/auth/callback`.
