# @agent-kernel/eval-sdk

Public SDK for Control Plane clients and extension packages. Agent backends, benchmark adapters, sandbox providers, and defect detectors implement protocol contracts through this package; they do not import orchestrator internals.

## External plugins

The package exports runtime interfaces, descriptor schemas, plugin types, and define helpers for Agent backends, benchmark/task-pack adapters, sandbox providers, and defect detectors. External packages use only @agent-kernel/eval-sdk; importing eval-orchestrator, eval-worker, product Host modules, or source-file paths is unsupported.

Copy one of the publishable starters in templates/:

- agent-adapter/ launches and normalizes an Agent inside a sandbox;
- task-pack/ resolves public tasks and runs declared verifiers;
- sandbox-provider/ supplies a contract-only isolated provider skeleton and never runs a workload;
- detector/ analyzes canonical immutable evidence and includes a public synthetic corpus.

Worker plugin modules export a non-empty evaluationPlugins array and are loaded with agent-eval-worker --plugin MODULE. Analyzer detector modules use the same export and are loaded with agent-eval-analyzer --plugin MODULE or AGENT_EVAL_ANALYZER_PLUGINS.

All external IDs use the `vendor:name` namespace form. Every descriptor declares an immutable version, supported protocol versions, and capabilities; runtime loading negotiates all three before `create()`. Loader isolation rejects private imports and uses separate module URLs. External Agent IDs and task-pack IDs are accepted protocol identifiers. External Agents are always unranked and cannot satisfy officialRequired; official/ranked status requires a platform protocol release and the complete certification/evidence gate. Plugin protocol-version arrays must overlap with the runtime. No legacy Host evaluation input is accepted or discovered.

See the contributor, security, compatibility, and release documents under docs/evaluation/.

The browser-safe `ControlPlaneClient` is shared by the CLI, CI clients, and production Web UI. Every mutation requires an idempotency key and returns a durable committed acknowledgement.
