# Recover a release handoff and execute its plan

This repository contains a compacted release-operations handoff. Recover the current facts for `owner`, `region`, `format`, and `channel` from `memory/workspace-release/`. Later records supersede earlier records. A revoked value must remain forgotten. `memory/foreign-workspace/` belongs to an unrelated task and must not contaminate the answer.

Then replace the TODO in `response.json` with one strict JSON object:

- `schemaVersion`: `1`;
- `memoryAnswers`: exactly one `{ factId, value }` for each requested fact;
- `plan.nodes`: the six required steps from `scripts/run-step.mjs`, each marked `completed` with `evidence/<step-id>.json`;
- `plan.dependencyEdges`: the prerequisite graph implied by the step definitions;
- `plan.parallelGroups`: identify branches that can run in either order;
- `plan.replans`: record how `incident/path-drift.json` replaces the superseded step.

After writing the plan, execute every required step using a literal command of the form `node scripts/run-step.mjs <step-id>`. Do not use a loop or variable for step IDs: native trace attribution is part of this evaluation. Respect prerequisites; independent branches may run in either order.

Do not modify `memory/`, `incident/`, `scripts/`, `tests/`, or `package.json`. Run the public tests and `node scripts/validate-submission.mjs` before finishing.
