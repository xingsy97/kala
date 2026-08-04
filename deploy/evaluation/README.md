# Standalone Agent Evaluation deployment

The deployment exposes the Control Plane and Dashboard on `127.0.0.1` by default. Do not start it until deployment secrets and the selected Worker boundary have been reviewed.

## Configure auth, signing, and model access

Copy [`deployment.env.example`](deployment.env.example) to the Git-ignored `deployment.env`. Keep every referenced file outside the repository with operator-only permissions. Compose mounts:

- the bearer auth configuration only into the Control Plane;
- one scoped token into each analyzer, Dashboard proxy, or Worker client;
- the reproduction signing key only into the analyzer;
- separate model credential settings into the selected Worker profile.

The auth config uses the existing `BearerAuthConfig` format. Tokens in the three token files must match distinct least-privilege principals in that config: analyzer (`analyzer:execute` plus required reads), Dashboard/operator, and Worker (`worker:execute` plus required reads). Secret values must never be placed in Compose environment values, command arguments, templates, or Git.

`AGENT_EVAL_MODEL_ENDPOINT_AUTHORITY` supplies the deployment-specific model `host:port`; `AGENT_EVAL_LXD_IMAGE` and `AGENT_EVAL_SWE_BENCH_LXD_IMAGE` supply reviewed local aliases or fingerprints. The one-shot `config-init` service renders them over non-routable markers into a private volume before readiness checks. Committed templates therefore contain no private address or environment-specific fingerprint.

Validate all profiles without creating containers:

```bash
docker compose --env-file deploy/evaluation/deployment.env \
  -f deploy/evaluation/compose.yaml --profile docker-worker --profile lxd-worker config --quiet
```

## Start one Worker boundary

Build the workspace, then start the control services and **exactly one** Worker profile:

```bash
pnpm build
docker compose --env-file deploy/evaluation/deployment.env \
  -f deploy/evaluation/compose.yaml --profile docker-worker up --build --wait
```

or:

```bash
docker compose --env-file deploy/evaluation/deployment.env \
  -f deploy/evaluation/compose.yaml --profile lxd-worker up --build --wait
```

`docker-worker` receives only `/var/run/docker.sock`, its socket group, and Docker-profile model settings. `lxd-worker` receives only the configured LXD socket/client, its socket group, and LXD-profile model settings. Never enable both profiles for a single Worker identity; the services have distinct identities and neither service mounts both sockets.

The Control Plane is available at `http://127.0.0.1:13100` with health endpoint `/healthz`; the Dashboard is at `http://127.0.0.1:13180/`. Set `AGENT_EVAL_BIND_ADDRESS` explicitly only when a reviewed firewall and TLS/authenticated reverse proxy protect a non-loopback bind.

Health checks gate dependent services. Restart policies, memory/CPU limits, and bounded `json-file` logs apply to every long-running service. Worker readiness validates its scoped credentials, rendered templates, socket access, pinned images, network policy, and Agent configuration before accepting trials.

Stop with:

```bash
docker compose --env-file deploy/evaluation/deployment.env -f deploy/evaluation/compose.yaml down
```

Add `-v` only when deliberately deleting standalone evaluation state. The deployment does not discover or mount product Host evaluation/session/artifact paths.

Release-gate examples for GitHub Actions, GitLab CI, and Jenkins are in [`ci/`](ci/README.md).
