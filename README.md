# Agent RunLab

Agent RunLab is an agent backend built around an Agent Pure Function Kernel: a replayable FSM where `(state, input)` produces `{ nextState, effects }`.

The Host wraps that kernel, owns sessions, providers, APIs, ledgers, artifacts, and routing, then coordinates with an executor fleet that can run across many local, remote, GPU, or CI machines.

The same backend supports three usage lines: a product dashboard for interactive sessions, benchmark runners for agent evaluation, and integration with RL, training, or inference frameworks.

```text
 Product Line          Benchmark Line          RL Line
 dashboard             benchmark runners       RL / training /
 sessions              eval artifacts          inference frameworks
      \                     |                         /
       \                    |                        /
        +-------------------+-----------------------+
                            |
                            v
+------------------------------------------------------------+
| Host                                                       |
| sessions / ledger / providers / executor routing / APIs    |
| artifacts / benchmarks / rollout integration               |
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
