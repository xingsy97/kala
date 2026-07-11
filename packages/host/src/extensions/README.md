# Host extensions

Optional capabilities layered on top of the host loop. **Each file here is
something the kernel does not need to run.** Delete any one of them (and its
single call site in `../loop.ts` / `../connection/dashboard-ns.ts` / `../../bin/`)
and the agent still drives a session to completion  -  it just loses that one
feature. This is the concrete expression of [ADR 0005](../../../../docs/meta/adr/0005-kernel-boundary.md):
planning, memory, and subagents live *outside* the kernel, and  -  by the same
logic  -  outside the core host driver too.

Contrast with the modules one level up in `src/` (`loop.ts`, `llm/`, `store/`,
`connection/`, `server.ts`): those are the **kernel driver**. Remove any of them
and nothing runs. The split is physical so a reader can tell "required skeleton"
from "bolt-on" at a glance.

## The dependency rule

Extensions depend on the loop's **contract**, never on the loop's guts:

```
extensions/*.ts  - imports -  ../loop-types.ts   (pure types: HostLoopDeps, LoopHandle,  - )
extensions/*.ts  - imports -  ../loop.ts          (one value only: dispatchOne, the re-entry point)
../loop.ts       - imports -  extensions/*.ts     (the entry functions below)
```

`loop-types.ts` is a leaf module (no runtime logic, imports nothing that imports
it back), so the type dependency doesn't close a cycle. The loop imports each
extension's entry function; the extension imports only types plus `dispatchOne`.
That one-way shape is what keeps the core readable in isolation  -  you can read
`loop.ts` top to bottom and treat every extension as a named seam.

Extensions with **no** core dependency at all (`hooks.ts`, `skills.ts`  -  pure
functions over child processes / the filesystem) don't even import
`loop-types.ts`.

## Integration phases

The loop exposes a fixed set of seams. Each extension plugs into one or more:

| Phase | When | Extension | Entry point  -  call site |
|---|---|---|---|
| **beforeCallLlm** | before each LLM call | compaction (preflight) | `maybeAutoCompact`-adjacent `compact()`  -  `loop.ts` `messagesForLlmCall` |
| **beforeCallTool** | before a tool dispatches | hooks (pre) + loop-guard | `runPreToolHooks`  -  `loop.ts:295` |
| **provideTool** | tool dispatch itself | agent builtin, skills | `runAgentTool`  -  `loop.ts:314`, `runSkillTool`  -  `loop.ts:317` |
| **afterCallTool** | after a tool settles | hooks (post) | `runPostToolHooks`  -  `loop.ts:320` |
| **onTurnDone** | after a turn completes | compaction (auto) | `maybeAutoCompact`  -  `loop.ts:88` |
| **manualTrigger** | operator command | compaction (`/compact`), memory | `runCompact`  -  `loop.ts:97`, `consolidateMemory`  -  `connection/dashboard-ns.ts:457` |
| **discovery** | host startup | skills, hooks | `discoverSkills` / `createHookRunner`  -  `bin/agent-kernel-host.ts` |

## The files

| File | Phase(s) | Depends on core? |
|---|---|---|
| `compaction.ts` | beforeCallLlm, onTurnDone, manualTrigger | types + `dispatchOne` |
| `agent-tool.ts` | provideTool | types + `dispatchOne` + `SessionStore` |
| `hooks-runner.ts` | beforeCallTool, afterCallTool | types only |
| `hooks.ts` | discovery (runner) | no  -  pure, `node:child_process` |
| `skills.ts` | provideTool, discovery | no  -  pure, kernel `ToolSchema` only |
| `memory-consolidation.ts` | manualTrigger | types only |

## Why this isn't a registry (yet)

The dispatch in `loop.ts`'s `performCallTool` still hard-codes
`effect.name === AGENT_TOOL_NAME` / `SKILL_TOOL_NAME`. A typed `Extension`
interface with a `registry.fire(phase)` fan-out is the natural next step, but the
seven phases above don't collapse into one clean interface without guessing at
future needs. This round only relocated the code and broke the cycle; the
registry is a deliberate follow-up. See [ADR 0005](../../../../docs/meta/adr/0005-kernel-boundary.md)
for the boundary this directory enforces.
