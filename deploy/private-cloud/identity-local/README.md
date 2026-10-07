# Bundled localhost identity secrets

This overlay is only for a first install reached through HTTP loopback. It is source material for the private-cloud bundle, whose builder flattens this directory's `Caddyfile` to `identity-local.Caddyfile` beside the Compose files. Do not invoke the source overlay directly: its relative Caddyfile mount is intentionally resolved only in the generated bundle.

Set `KALA_IDENTITY_SECRETS_DIR` to an absolute operator-managed directory. The directory must be mode `0700`; every file must be a regular, non-symlink file with mode `0600` or `0400` and no trailing newline:

- `postgres_password`: at least 16 random bytes.
- `zitadel_masterkey`: exactly 32 random bytes, as required by ZITADEL.
- `initial_human_password`: at least 16 random bytes. ZITADEL creates `zitadel-admin` with this password and requires it to be changed on first login.

Use single-line, high-entropy printable values. The initial human password is read by the one-shot init container into a protected file-backed ZITADEL configuration; it is never placed in a Compose environment variable or container command. Keep the directory after installation for recovery, and protect it independently of Kala tenant storage.

The only published identity socket is the literal `127.0.0.1:13002`. Kala ingress reaches discovery internally at `http://identity-proxy:8080` while the public issuer remains `http://localhost:13002`.
