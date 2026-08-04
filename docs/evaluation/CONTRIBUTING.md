# Contributing evaluation extensions

Use the public @agent-kernel/eval-sdk package and begin with a starter under packages/eval-sdk/templates. An extension package must be independently installable and buildable; it must not import orchestrator, Worker, Analyzer internals, product Host evaluation code, relative workspace source paths, or historical evaluation data.

## Adapter checklist

1. Choose a stable namespaced `vendor:name` protocol identifier and immutable semantic version.
2. Declare every supported protocol version and capability; loaders negotiate these before creation.
3. Parse descriptors and inputs with exported SDK schemas.
4. Export a non-empty evaluationPlugins array using a define plugin helper.
5. Run all untrusted commands through SandboxExecutionTarget; never on the Worker or Analyzer host.
6. Preserve native events/results and produce canonical normalized evidence.
7. Use credential reference IDs only. Never persist, log, or put resolved secret values in host process arguments.
8. Ship deterministic tests and public synthetic fixtures with explicit license, evaluation permission, and provenance.

Agent adapters must implement cancellation, absolute deadlines, version/config evidence, final diff, and explicit usage availability. External Agents remain unranked. Task packs must pin repositories, images, fixture hashes, verifier versions, and every verification step. Sandbox providers must enforce isolation and verified cleanup; the starter intentionally does not run workloads. Detectors must ship positive and negative cases plus measured precision/recall and return immutable evidence references.

Run pnpm verify:evaluation-contributor. It packs the public protocol and SDK, copies the starters to a clean temporary directory, installs only the packed packages and public npm dependencies, compiles Agent, Benchmark, Sandbox, and Detector extensions, loads all plugin exports in isolation, negotiates descriptor/version/capabilities, validates its synthetic fixtures, and scans for private imports.
