# Shared Identity Stack

This Compose project owns the shared ZITADEL lifecycle independently of Agent RunLab.
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
cp deploy/saas/.secrets/postgres_password deploy/identity/.secrets/postgres_password
cp deploy/saas/.secrets/zitadel_masterkey deploy/identity/.secrets/zitadel_masterkey
chmod 600 deploy/identity/.secrets/*
```

The Compose project currently adopts the existing ZITADEL database, bootstrap and
configuration volumes by explicit external names for a data-preserving migration. Do not
run `down -v`; back up PostgreSQL before upgrades. Other applications should create their
own OIDC application/client and use the configured canonical issuer.

Agent RunLab is only an OIDC client of this stack. Its callback is
`https://<runlab-domain>/auth/callback`.
