# Standalone Runtime Unit External Cutover

**Status:** normative operator runbook
**Applies to:** migration from the legacy single-process Standalone service to Stable Ingress, Runtime Unit `local`, and Deploy Supervisor
**Execution boundary:** run from an external administrative shell, never from a Session hosted by the target Runtime Unit

## Preconditions

- The release passed component, integration, Shadow installation, successful cutover, and rollback tests.
- The release contains Host, Ingress, Supervisor, systemd templates, install script, cutover script, manifest, and checksums.
- A restorable backup or platform snapshot exists.
- The legacy mutable data root is known to the operator.
- The legacy service name is known to the operator.
- No earlier migration receipt is active.
- The target is a supported Linux environment with Node.js 22+, systemd, and `flock`.

## Stage without production interruption

From the external administrative shell:

```bash
sudo env \
  AGENT_RUNLAB_RELEASE_ID=<release-id> \
  AGENT_RUNLAB_LEGACY_DATA_ROOT=<legacy-data-root> \
  node install-standalone-systemd.mjs <release-directory>
```

Expected result:

```json
{"ok":true,"phase":"installed_disabled","releaseId":"<release-id>"}
```

Staging must not stop, restart, or modify the active legacy service. The three new services remain disabled and stopped.

## Preflight

Verify:

```bash
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  agent-runlab-ingress.service \
  agent-runlab-unit@.service \
  agent-runlab-deploy-supervisor.service
sudo test -f <data-root>/deploy/migration-receipt.json
sudo test -L <data-root>/deploy/current
sudo test -r <legacy-data-root>/sessions
```

Confirm no hosted Session is being used to execute the following cutover command.

## Cutover

```bash
sudo env \
  AGENT_RUNLAB_LEGACY_SERVICE=<legacy-service> \
  node cutover-standalone-systemd.mjs
```

The script performs this bounded sequence:

1. stop the legacy service;
2. copy compatible mutable data into Unit `local`;
3. assign the Unit service account as owner;
4. start private Unit `local`;
5. verify the full Standalone capability profile;
6. start Stable Ingress on the public address;
7. verify public routing;
8. start Deploy Supervisor;
9. persist a completed migration receipt.

If any mandatory step fails, the script stops the new services, restarts the legacy service, and persists a rollback receipt.

## Post-cutover verification

All checks are mandatory:

```bash
systemctl is-active agent-runlab-ingress.service
systemctl is-active user4@example.com
systemctl is-active agent-runlab-deploy-supervisor.service
curl -fsS <public-origin>/runtime/capabilities
curl -fsS <private-unit-origin>/internal/runtime/quiescence
```

The capability response must indicate Standalone mode and enabled Agent, Workspace, Operations/Benchmark, Artifacts, and Pipeline/Evaluation integration.

Then verify through the product UI:

- Dashboard loads without console or request errors;
- an existing Session is readable;
- a new Session can be created;
- a Workspace Executor reconnects;
- File, Git, and Shell operations complete;
- Artifact access works;
- Benchmark and Evaluation entry points remain available;
- an immutable test deployment produces a completed receipt;
- a deliberately unhealthy release produces a rolled-back receipt.

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

```bash
sudo systemctl stop agent-runlab-deploy-supervisor.service
sudo systemctl stop agent-runlab-ingress.service
sudo systemctl stop user4@example.com
sudo systemctl start <legacy-service>
```

Use the untouched original data root for the legacy service. If new Unit writes occurred after cutover, do not merge Session files manually; preserve both roots and follow the data-recovery procedure.

## Completion

The migration is complete only after the observation window and backup-restore verification. Removal of the legacy service and retired releases is a separate, explicit operator action.
