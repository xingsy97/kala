# Platform components

Status: TypeScript standalone evaluation services implemented

## Component ownership

| Component | Responsibility |
|---|---|
| `eval-protocol` | Browser-safe canonical schemas and protocol negotiation |
| `eval-sdk` | Public plugin/runtime interfaces and contributor starters |
| `eval-orchestrator` | Durable authority, scheduling, commands, queries, artifacts, reports |
| `eval-worker` | Leased isolated execution, verification, staging, cleanup |
| `eval-analyzer` | Detector and grading job consumers |
| `eval-dashboard` | Production Web client of the Control Plane |
| `adapters/agents` | Agent RunLab, Claude Code, Codex, and non-ranked utilities |
| `adapters/benchmarks` | Native and official benchmark/task-pack adapters |
| `adapters/environments` | Docker, LXD container, and LXD VM providers |

The product Host and Dashboard do not provide evaluation orchestration, evaluation artifact discovery, or compatibility routes. Product session profiling and RL utilities remain product-owned when they do not create a second evaluation authority.

## Packaging and deployment

Each service and plugin package is independently buildable. Compose images install production dependencies from the workspace lockfile and use explicit entry points. The Worker image pins its Docker CLI base and receives plugins explicitly at process startup. See [`deploy/evaluation/README.md`](../../deploy/evaluation/README.md).

```bash
pnpm build
pnpm test
pnpm verify:evaluation-boundaries
docker compose -f deploy/evaluation/compose.yaml up --build --wait
```

CI examples for GitHub Actions, GitLab CI, and Jenkins consume the same standalone gate output. External contributors build against packed public `eval-protocol` and `eval-sdk` packages in a clean workspace.

## Language strategy

TypeScript owns the Control Plane, Worker, Analyzer, Dashboard, SDK, and adapters. Python remains appropriate inside pinned official benchmark tool layers such as SWE-Bench. Go or other services may be added only behind the versioned protocol and must not create another durable writer or artifact-discovery path.

## Verification

The current release evidence covers independent service images, real Worker deployment, protocol negotiation, rolling recovery, browser behavior, external contributor packaging, CI outputs, governance, and fresh benchmark runs. The implementation ledger records which remaining production invariants still need direct evidence.
