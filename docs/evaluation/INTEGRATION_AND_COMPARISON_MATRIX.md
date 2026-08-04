# Benchmark integration and controlled comparison

The canonical supported-pack list is [`canonical-pack-inventory.json`](canonical-pack-inventory.json). Deployment templates, the design manifest, and real runners must match that inventory. This distinction implements the experiment requirement in [`SECOND_REVIEW.md`](SECOND_REVIEW.md#p1-adapters-and-experiment-findings).

## Integration matrix

An integration cell is identified by pack, Agent backend, sandbox provider, verifier, and explicit credential mode. Passing it establishes adapter/lifecycle compatibility only. It answers “can this supported combination complete the governed lifecycle?” It does not establish relative quality and must remain `unranked_integration_only`, even when multiple Agents run the same fixture.

## Controlled comparison coordinates

A controlled comparison answers “which variant performed better under declared equal conditions?” Ranking is permitted only when every compared trial declares equal task IDs/hash, dataset revision, slice manifest, verifier ID/version, sandbox provider/image, model ID/revision, inference parameters, tool policy, token/time budgets, network policy, and repeats. A missing or unequal coordinate changes the result to `unranked_integration_only`; no winner, ordering, or leaderboard claim may be emitted. Integration evidence cannot be promoted to a controlled comparison after the run by filling missing metadata.

Formal runs accept credentials only through `AGENT_EVAL_CREDENTIAL_LOCAL_API_KEY` or an explicit `--credential-helper`. User-level Claude `apiKeyHelper` discovery is intentionally disabled.

Every trial must include a cleanup receipt with zero instance, network, ACL, volume, and credential-file residue counters. Build identity is the package version plus the explicitly injected `AGENT_EVAL_BUILD_REVISION` commit.
