# @agent-kernel/eval-orchestrator

The standalone Evaluation Control Plane. It is the only durable authority for accepted run specifications, run and trial state, command acknowledgements, Worker registrations, leases, result commits, audit records, and projections.

The service does not import Agent RunLab Host, Executor, product Dashboard, or pre-refactor evaluation state. CLI and Web clients use the same versioned HTTP command/query APIs.
