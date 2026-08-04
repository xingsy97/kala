# Evaluation plugin compatibility

Compatibility is negotiated through `descriptor.protocolVersions` and declared `capabilities`. Protocol version 1 is the current public contract. Agent descriptors expose structured capabilities; Benchmark, Sandbox, and Detector descriptors expose capability ID arrays. A runtime rejects a plugin when the version sets do not overlap, required capabilities are absent, the exported descriptor differs from the created instance, an ID is duplicated, or an Analyzer module exports a non-detector plugin.

Patch and minor SDK releases may add optional helpers and types without changing version-1 behavior. A required field, semantic change, removal, or evidence-invariant change requires a new protocol version. Plugins can list multiple explicitly supported versions during a controlled transition; there is no legacy-v1 endpoint, Host shim, historical reader, forwarding route, dual write, or automatic interpretation of old Host sessions/artifacts.

External Agent, benchmark/task-pack, sandbox-provider, and detector IDs are open but must be namespaced as `vendor:name`; sandbox descriptors apply this to `providerId`. Worker and Analyzer loaders scan local static imports, reject private platform packages and SDK private subpaths, and import each accepted entry through an isolated module URL. This module isolation is not a process security boundary: workload execution remains inside a Sandbox. External Agents are unranked and cannot satisfy official verification. Admission to the fixed official/ranked set requires a platform release, shared certification, real fresh-sandbox evidence, and Leaderboard eligibility review.

## Benchmark provenance labels

- **SWE-Bench** is a local run of the pinned official SWE-Bench harness. UI and catalog labels must retain both “pinned official harness” and “local run”; an official harness does not imply a hosted or organizer-operated run.
- **Terminal-Bench-compatible, ProgramBench-compatible, SWE-Marathon-compatible, and SDLC** integrations are non-official compatible/local task packs because no pinned upstream harness is integrated for them. Their local verifier metrics are useful product evidence, but are not official benchmark results and must not be labeled, ranked, or used in completion claims as such.
- Dataset, task-pack, run-template, completion, and result surfaces must display this provenance rather than relying on a benchmark-like identifier alone.

## Immutable design manifest

[`benchmark-design-manifest.json`](benchmark-design-manifest.json) binds each in-scope pack to the same task, dataset revision, slice, verifier, and fresh container policy for Agent RunLab, Claude Code, and Codex. It also defines the required cleanup receipt and zero-residue schema. The manifest is design metadata, not execution evidence; validate it without model calls using `node scripts/evaluation/verify-benchmark-design-manifest.mjs` from the repository root.
