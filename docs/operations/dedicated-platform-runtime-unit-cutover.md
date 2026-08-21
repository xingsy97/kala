# Dedicated Platform Runtime Unit External Cutover

**Status:** normative operator runbook
**Applies to:** migration from the legacy single-process Dedicated service to Stable Ingress, logical Runtime Unit `local` with `blue`/`green` slots, Deploy Supervisor, and the static Control Updater
**Execution boundary:** run from an external administrative shell, never from a Session hosted by the target Runtime Unit

## Preconditions

- The release passed component, integration, Shadow installation, successful cutover, and rollback tests.
- The release contains Host, Ingress, Supervisor, systemd templates, install script, cutover script, manifest, and checksums.
- A restorable backup or platform snapshot exists.
- The legacy mutable HOME or `.agent-kernel` state root is known to the operator; migration includes Sessions, Artifacts, Executor identities, Workspace aliases, encrypted credential master key, Web Search credential, Push VAPID key, Audit, Memos, Session Artifact registry, Claude provider settings, manual model catalog, and Agent runtime settings without logging their contents.
- The cutover records and compares a sanitised settings fingerprint containing only provider IDs, model refs, and default model; any drift triggers automatic rollback.
- If Docker-backed Benchmark/Evaluation is enabled, the dedicated LXD/VM boundary is accepted as the security boundary and `agent-runlab` Docker-group membership is explicitly recorded; otherwise set `AGENT_RUNLAB_CONTAINER_BACKEND=none`.
- The legacy service name is known to the operator.
- No earlier migration receipt is active.
- The target is a supported Linux environment with Node.js 22+, systemd, and `flock`.

## Stage without production interruption

From the external administrative shell:

```bash
sudo env \
  AGENT_RUNLAB_RELEASE_ID=<release-id> \
  AGENT_RUNLAB_LEGACY_DATA_ROOT=<legacy-data-root> \
  node install-dedicated-systemd.mjs <release-directory>
```

Expected result:

```json
{"ok":true,"phase":"installed_disabled","releaseId":"<release-id>"}
```

Staging must not stop, restart, or modify the active legacy service. All new services remain disabled/inactive; the Control Updater remains static and inactive.

## Preflight

Verify:

```bash
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  agent-runlab-dedicated-ingress.service \
  agent-runlab-dedicated-unit@.service \
  agent-runlab-dedicated-deploy-supervisor.service \
  agent-runlab-dedicated-control-updater.service \
  agent-runlab-dedicated-migration-finalizer.service
sudo test -f <data-root>/deploy/migration-receipt.json
sudo test -L <data-root>/deploy/current
sudo test -r <legacy-data-root>/sessions
```

Confirm no hosted Session is being used to execute the following cutover command.

## Cutover

```bash
sudo env \
  AGENT_RUNLAB_LEGACY_SERVICE=<legacy-service> \
  node cutover-dedicated-systemd.mjs
```

The script performs this bounded sequence:

1. stop the legacy service;
2. copy compatible mutable data into Unit `local`;
3. assign the Unit service account as owner;
4. start private slot `blue` for logical Unit `local`;
5. verify the full Dedicated capability profile and single-writer lease;
6. atomically move the large `.agent-kernel` state tree within the same filesystem (no 27GB duplicate), change ownership, copy only bounded provider settings, publish generation-1 route state, and start Stable Ingress on the public address;
7. verify public routing;
8. start Deploy Supervisor;
9. persist a completed migration receipt.

If any mandatory step fails, the script stops the new services, restarts the legacy service, and persists a rollback receipt.

## Post-cutover verification

All checks are mandatory:

```bash
systemctl is-active agent-runlab-dedicated-ingress.service
systemctl is-active agent-runlab-dedicated-unit@blue.service || systemctl is-active agent-runlab-dedicated-unit@green.service
systemctl is-active agent-runlab-dedicated-deploy-supervisor.service
curl -fsS <public-origin>/runtime/capabilities
curl -fsS <private-unit-origin>/internal/runtime/quiescence
```

The capability response must indicate Dedicated mode and enabled Agent, Workspace, Operations/Benchmark, Artifacts, and Pipeline/Evaluation integration.

Then verify through the product UI:

- Dashboard loads without console or request errors;
- an existing Session is readable;
- a new Session can be created;
- a Workspace Executor reconnects;
- File, Git, and Shell operations complete;
- Artifact access works;
- Benchmark and Evaluation entry points remain available;
- an immutable test deployment stops `blue`, starts and privately verifies `green`, then atomically routes new traffic to `green` and produces a completed receipt;
- a deliberately unhealthy release never receives public routing, restores the previous slot and route, and produces a rolled-back receipt;
- the inactive slot cannot acquire the shared logical Unit write lock while the active slot is running;
- only the routed active slot is systemd-enabled, the inactive slot is disabled, and a full LXD/VM reboot restores Ingress, Supervisor, the routed slot, Session readability, and container-backend access.

## Observation window

Keep the legacy service definition, original data root, previous release, and backup during the observation window. Do not delete them merely because the first health check passed.

Monitor:

- Unit restarts and readiness;
- Ingress proxy failures;
- Executor reconnect failures;
- Session append errors;
- deployment and rollback receipts;
- disk growth and write-lease conflicts.

## Manual rollback

If a post-cutover defect appears during the observation window:

Run the packaged external rollback transaction:

```bash
sudo env \
  AGENT_RUNLAB_LEGACY_SERVICE=<legacy-service> \
  node rollback-dedicated-systemd.mjs
```

The transaction stops both slots and control services, restores ownership, atomically moves `.agent-kernel` back to the legacy HOME, removes the bounded copied provider files, starts the legacy service, and verifies its public capability endpoint. Never start the legacy service directly while the state tree remains under `/var/lib/agent-runlab`; that would create an empty or divergent state root. If new Unit writes occurred after cutover, the move preserves them as the new legacy authority; do not merge Session files manually.

## Completion

The migration is complete only after the observation window and backup-restore verification. Removal of the legacy service and retired releases is a separate, explicit operator action.
