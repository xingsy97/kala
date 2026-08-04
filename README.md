# Agent RunLab

Agent RunLab is an agent backend built around an Agent Pure Function Kernel: a replayable FSM where `(state, input)` produces `{ nextState, effects }`.

The Host wraps that kernel, owns sessions, providers, APIs, ledgers, artifacts, and routing, then coordinates with an executor fleet that can run across many local, remote, GPU, or CI machines.

The repository contains three deliberately separate usage lines: Agent RunLab
for interactive product Sessions, a standalone evaluation platform, and RL /
training / inference integrations. The product Host does not expose evaluation
routes or read historical evaluation artifacts.

```text
 Product Line          Evaluation Line          RL Line
 dashboard             Control Plane            RL / training /
 sessions              Workers / Analyzer       inference frameworks
 Host + Executor       eval-dashboard
      |                      |                         |
      +----------------------+-------------------------+
                             |
                     shared repository
                             |
                             v
+------------------------------------------------------------+
| Host                                                       |
| sessions / ledger / providers / executor routing / APIs    |
| product artifacts / rollout integration                    |
|                                                            |
|             +--------------------------------+             |
|             | Agent Pure Function Kernel     |             |
|             | (state, input) ->              |             |
|             |   { nextState, effects }       |             |
|             | replayable FSM / reducer       |             |
|             +--------------------------------+             |
|                                                            |
|   LLM / Inference Providers        Executor Fleet          |
|   model servers / APIs             local / remote / GPU/CI |
+------------------------------------------------------------+
```

Standalone evaluation is owned by `packages/eval-*`, `adapters/`, and
`task-packs/`; it communicates through the canonical evaluation protocol and
never falls back to product Session artifacts.
