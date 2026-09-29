---
name: local-dedicated-redeploy
description: Build, verify, and deploy the current Kala checkout to a local Dedicated LXD environment with a safe blue-green cutover.
---

# Local Dedicated redeployment

Use this procedure when asked to rebuild and redeploy the current checkout to a
local Kala Dedicated environment. Never copy real hostnames, tokens, paths,
session IDs, deployment IDs, or user content into this skill or command history.
Replace every placeholder at execution time from operator-provided or locally
discovered non-secret values.

## Inputs

- `<REPOSITORY_ROOT>`: current Kala checkout.
- `<LXD_CONTAINER>`: target local LXD container.
- `<REPOSITORY_SLUG>`: release repository identifier, such as
  `owner/repository`.
- `<DEPLOY_TIMEOUT_MS>`: bounded wait timeout, normally `600000`.
- `<PUBLIC_LISTENERS>`: comma-separated host IP literals and ports.
- `<PUBLIC_URLS>`: comma-separated exact or wildcard public URLs accepted by
  Kala.

Do not print environment files, credentials, message contents, or complete
session records. Redact secrets from diagnostics and restrict inspection to
service state, release metadata, receipt phases, counts, and bounded errors.

## Procedure

1. Confirm the worktree and target without modifying unrelated changes:

   ```bash
   cd <REPOSITORY_ROOT>
   git status --short
   lxc exec <LXD_CONTAINER> -- systemctl --no-pager --full status \
     kala-dedicated-ingress.service \
     kala-dedicated-deploy-supervisor.service
   ```

2. Install the frozen dependency graph in the build environment:

   ```bash
   lxc exec <LXD_CONTAINER> -- sh -lc \
     'cd <CONTAINER_REPOSITORY_ROOT> && pnpm install --frozen-lockfile'
   ```

3. Build a CJS release and verify its closed asset inventory:

   ```bash
   lxc exec <LXD_CONTAINER> -- sh -lc \
     'cd <CONTAINER_REPOSITORY_ROOT> &&
      NODE_OPTIONS=--max-old-space-size=<BUILD_HEAP_MB> \
      node scripts/release/build-release-assets.mjs \
        --no-native --repo <REPOSITORY_SLUG> &&
      node scripts/release/verify-release-assets.mjs &&
      node scripts/release/verify-release-install.mjs'
   ```

4. Stage the verified local-development Runtime release:

   ```bash
   cd <REPOSITORY_ROOT>
   node scripts/deploy/deploy-dedicated.mjs stage \
     --lxd <LXD_CONTAINER> \
     --local-development \
     --skip-build
   ```

   Capture the returned `<OPERATION_ID>`, `<DEPLOYMENT_ID>`, and
   `<RELEASE_ID>`. Do not invent or reuse identifiers.

5. Wait for the authoritative receipt:

   ```bash
   node scripts/deploy/deploy-dedicated.mjs wait <OPERATION_ID> \
     --lxd <LXD_CONTAINER> \
     --timeout-ms <DEPLOY_TIMEOUT_MS>
   ```

   Completion requires `phase: completed`, a new route generation, successful
   public-route health, and zero failed continuation sessions.

6. Deploy the independently versioned Dashboard release:

   ```bash
   cd <REPOSITORY_ROOT>
   node scripts/deploy/deploy-dashboard.mjs stage \
     --lxd <LXD_CONTAINER> \
     --skip-build
   ```

   Capture the returned `<DASHBOARD_OPERATION_ID>` and wait for its separate
   authoritative receipt:

   ```bash
   node scripts/deploy/deploy-dashboard.mjs wait <DASHBOARD_OPERATION_ID> \
     --lxd <LXD_CONTAINER> \
     --timeout-ms <DEPLOY_TIMEOUT_MS>
   ```

   Dedicated Runtime and Dashboard releases use independent route generations.
   A successful Runtime deployment does not update the Dashboard served by
   Ingress. Always complete this step when the requested redeploy includes UI
   changes.

7. Configure the public URL policy inside the container and the host-side LXD
   listeners. This manages only `kala-public-*` proxy devices and must not
   modify an independently managed reverse proxy, VPN, or tunnel:

   ```bash
   printf '%s\n' 'KALA_PUBLIC_URLS=<PUBLIC_URLS>' |
     lxc exec <LXD_CONTAINER> -- sh -lc \
       'umask 077; cat > /etc/kala/ingress.env'
   lxc exec <LXD_CONTAINER> -- systemctl restart \
     kala-dedicated-ingress.service
   KALA_PUBLIC_LISTEN='<PUBLIC_LISTENERS>' \
     node scripts/deploy/configure-lxd-public-listeners.mjs \
       --lxd <LXD_CONTAINER>
   ```

8. Verify every configured route and bounded service logs:

   ```bash
   lxc exec <LXD_CONTAINER> -- sh -lc \
     'cat <DEPLOY_ROOT>/route-state.json &&
      cat <DEPLOY_ROOT>/dashboard/route-state.json &&
      curl -fsS <LOCAL_INGRESS_ORIGIN>/runtime/capabilities &&
      journalctl -u kala-dedicated-unit@<ACTIVE_SLOT>.service \
        --since "<DEPLOY_STARTED_AT>" --no-pager |
        grep -Ei "<KNOWN_FAILURE_PATTERN>" && exit 1 || true'
   curl -fsS <PUBLIC_ORIGIN>/healthz
   ```

## Upgrade compatibility

If an older Supervisor rejects a current local release solely because it knows
the previous exact asset inventory, perform one bootstrap deployment:

```bash
node scripts/deploy/deploy-dedicated.mjs stage \
  --lxd <LXD_CONTAINER> \
  --local-development \
  --legacy-local-development \
  --skip-build
```

Wait for that operation before staging the full current release. This option is
only a compatibility bridge; never use it for routine redeployments.

## Failure handling

- Treat the deployment receipt as authoritative.
- Do not manually switch route-state files or overwrite immutable releases.
- If verification fails, confirm the predecessor route is serving before
  investigating the candidate.
- Inspect only the failed continuation ID and bounded error. Use repository APIs
  for queue repair; preserve append-only history and write cancellation
  tombstones rather than deleting session logs.
- Never push or commit unless the user explicitly requests it.
