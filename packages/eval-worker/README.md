# @agent-kernel/eval-worker

Workers register sandbox-provider, Agent-backend, and benchmark-adapter capabilities. The Control Plane only leases a trial when all three match its immutable run specification. Plugins and credential references are explicit deployment inputs; credentials are resolved in Worker memory and are never stored in the run specification.

Independent execution/data-plane process. For each lease it creates a fresh sandbox, resolves one Agent backend and benchmark adapter through public SDK registries, executes the Agent and verifier, stages immutable evidence, destroys the sandbox, verifies cleanup, and commits exactly one typed terminal result to the Control Plane.

This package does not import Agent RunLab Host, Executor, product Dashboard, or orchestrator internals. Agent-specific process topology belongs to the relevant adapter package.
