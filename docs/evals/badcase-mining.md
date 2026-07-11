# Bad-case mining

Bad-case mining scans a completed evaluation run's trial artifacts and produces
a normalized list of failing, timed-out, or unresolved cases so a human can
triage them and, later, export them as training data (SFT / RL).

The mining logic lives in `packages/host/src/eval/badcase-mining.ts`. Exports
live in `packages/host/src/eval/badcase-export.ts`. Annotations are appended to
`<runId>/badcase-annotations.jsonl` inside the run directory (see
`packages/host/src/eval/badcase-annotations.ts`).

The dashboard surface is the `Bad Cases` tab of the Artifact Explorer dialog.

## Failure categories

| Category | Typical case |
| --- | --- |
| `patch-apply-failure` | SWE-bench trial with `failureLabel = patch_apply_failed` or `empty_patch`: the model produced a diff that didn't apply cleanly against the target repo. |
| `test-timeout` | Trial exceeded its wall-clock budget (SWE-bench `status = timed_out` or `failureLabel = agent_timeout`; Terminal-Bench `agentTimedOut` / `testTimedOut`). |
| `agent-error` | Agent runtime raised an unhandled exception mid-trajectory (`failureLabel = agent_error` or Terminal-Bench `errorMessage` mentioning `agent`). |
| `infra-error` | Host, sandbox, or verifier plumbing died before/around the trial (`failureLabel = infrastructure_error` or `harness_error`; Terminal-Bench `status = errored`). |
| `verifier-failure` | Patch applied and tests ran, but not all expected tests passed (`failureLabel = test_failed`; Terminal-Bench `parserOutput.allPassed = false`). |
| `unresolved-other` | Trial finished without being resolved and doesn't fit any other bucket. |

## HTTP actions

All three actions POST to `/enhancement/action` with `{action, runId, ...}`:

- `badcase-list`: `{runId}` -> `{counts, cases: [...]}` with any prior
  annotations merged in per case.
- `badcase-annotate`: `{runId, instanceId, label, note?}` -> `{updatedAt}`.
  `label` must be one of `not-a-bug | needs-more-context | model-limitation |
  infra-flake | worth-retraining`.
- `badcase-export`: `{runId, instanceIds, format: 'sft' | 'rl'}` ->
  `{format, count, content}` where `content` is JSONL.

## Export shapes

- **SFT** (`exportForSFT`): `{ instruction, trace: { head, tail, toolCallErrors }, gold? }`
- **RL** (`exportForRL`): `{ prompt, rollout, reward: 0, reason }`

Rewards are always `0` for bad cases; the export is intended to seed
`worth-retraining` failures into a training pipeline (verified rewards must be
computed separately by a verifier).

## No absolute paths

The mining layer only exposes per-instance identifiers and short in-line trace
excerpts. Filesystem paths never appear in the HTTP response envelope or in
dashboard UI text — see docs/principles.md A1.
