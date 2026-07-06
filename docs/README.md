# docs/

Documentation index for `agent-kernel`. If you're new here, start with the project [README](../README.md)  -  it has curated reading paths for different intents. This index is for looking up a specific doc when you already know what you want.

---

## Normative specs (implementers consume these)

| File | Purpose |
|---|---|
| [SPEC.md](SPEC.md) | The kernel contract  -  types, state machine, invariants |
| [protocol/wire-protocol.md](protocol/wire-protocol.md) | Every Socket.IO event between Dashboard, Host, and Executor |
| [protocol/event-log.md](protocol/event-log.md) | JSONL event log format for persistence, replay, fork |
| [tools.md](tools.md) | The 7 v1 tools Executor ships: schemas, outputs, errors |

## Design and rationale

| File | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Three-process topology and a full turn end-to-end |
| [platform.md](platform.md) | SaaS platformization design (multi-user cloud brain + local executors)  -  planned, not yet implemented |
| [mcp.md](mcp.md) | MCP runtime integration design (planned, not yet implemented) |
| [adr/](adr/) | Architecture Decision Records  -  one file per big call, with alternatives and consequences |

## Process

| File | Purpose |
|---|---|
| [ROADMAP.md](ROADMAP.md) | Shipped feature ledger, deferred items, non-goals |
| [testing.md](testing.md) | Test strategy at each layer + CI configuration |
| [RELEASING.md](RELEASING.md) | npm publish workflow (tag-driven) |

## Reference material

| File | Purpose |
|---|---|
| [references-comparison.md](references-comparison.md) | Quantitative comparison of Claude Code, Codex, opencode, pi  -  the 10 kernel design lessons |

---

## When docs disagree

If two docs contradict each other, the more normative one wins:

**SPEC.md > protocol/*.md > tools.md > everything else**

If you find such a contradiction, please open a PR to fix the lower-tier doc  -  that's the definition of a doc bug.

## When code disagrees with docs

**Docs win.** The kernel and its consumers are meant to be spec-driven. If the code does something the spec doesn't describe, either the code is buggy or the spec is missing something. Open an issue.

## Adding a new doc

- Normative? Add to  - Normative specs and make it as terse and unambiguous as possible.
- Explanatory? Add to  - Design and rationale.
- Process/how-to? Add to  - Process.
- Add a link here in the same PR.
