# Host extensions

Optional capabilities layered on top of the host loop. **Each file here is
something the kernel does not need to run.** The runtime composes them at
startup through `ExtensionRegistry`; removing a registration removes that
capability without adding a tool-name branch to the loop. This is the concrete
expression of [ADR 0005](../../../../docs/meta/adr/0005-kernel-boundary.md):
planning, memory, and subagents live *outside* the kernel, and — by the same
logic — outside the core host driver too.

Contrast with the modules one level up in `src/` (`loop.ts`, `llm/`, `store/`,
`connection/`, `server.ts`): those are the **kernel driver**. Remove any of them
and nothing runs. The split is physical so a reader can tell "required skeleton"
from "bolt-on" at a glance.

## The dependency rule

Extensions depend on the loop's **contract**, never on the loop's guts:

```
extensions/*.ts ──imports──▶ ../loop-types.ts    (pure host-loop contracts)
extensions/*.ts ──imports──▶ ../loop.ts          (only where re-entry is required)
../loop.ts      ──imports──▶ registry.ts         (generic lifecycle contract)
builtin-registry.ts ───────▶ concrete extensions (startup composition)
```

`loop-types.ts` is a leaf module (no runtime logic, imports nothing that imports
it back), so the type dependency doesn't close a cycle. The loop imports each
extension's entry function; the extension imports only types plus `dispatchOne`.
That one-way shape is what keeps the core readable in isolation — you can read
`loop.ts` top to bottom and treat every extension as a named seam.

Extensions with **no** core dependency at all (`hooks.ts`, `skills.ts` — pure
functions over child processes / the filesystem) don't even import
`loop-types.ts`.

## Integration phases

The loop exposes a fixed set of seams. Each extension plugs into one or more:

| Phase | When | Extension | Entry point → call site |
|---|---|---|---|
| **beforeCallLlm** | before each LLM call | compaction (preflight) | `maybeAutoCompact`-adjacent `compact()` ← `loop.ts` `messagesForLlmCall` |
| **beforeCallTool** | before a tool dispatches | registered lifecycle contributors, including command hooks | `ExtensionRegistry.beforeToolDispatch` |
| **provideTool** | tool dispatch itself | registered Host handlers, including agent, skills, web search, todo graph, and catalog tools | `dispatchConfiguredTool` resolves `ToolSchema.executionHandler` through `ExtensionRegistry` |
| **afterCallTool** | after a tool settles | registered lifecycle contributors, including command hooks | `ExtensionRegistry.afterToolDispatch` |
| **onTurnDone** | after a turn completes | compaction (auto) | `maybeAutoCompact` ← `loop.ts:88` |
| **manualTrigger** | operator command | compaction (`/compact`), memory | `runCompact` ← `loop.ts:97`, `consolidateMemory` ← `connection/dashboard-ns.ts:457` |
| **discovery** | host startup | skills, hooks | `discoverSkills` / `createHookRunner` ← `bin/kala-host.ts` |

## The files

| File | Phase(s) | Depends on core? |
|---|---|---|
| `compaction.ts` | beforeCallLlm, onTurnDone, manualTrigger | types + `dispatchOne` |
| `agent-tool.ts` | provideTool | types + `dispatchOne` + `SessionStore` |
| `hooks-runner.ts` | beforeCallTool, afterCallTool | types only |
| `hooks.ts` | discovery (runner) | no — pure, `node:child_process` |
| `skills.ts` | provideTool, discovery | no — pure, kernel `ToolSchema` only |
| `memory-consolidation.ts` | manualTrigger | types only |
| `registry.ts` | provideTool, beforeCallTool, afterCallTool | host-loop contract types |
| `builtin-registry.ts` | startup composition | concrete extension entry points |

## Agent modules and toolsets

The default host assembles its agent surface through `AgentModule`:

```
AgentModule = SystemPromptPlugin + ToolsetPlugin[] + RuntimePolicyPlugin?
```

`SystemPromptPlugin` owns the provider-facing system prompt. Each
`ToolsetPlugin` owns a named toolset, including tool prompt text, risk policy,
execution kind, and the handler name. The renderer in `src/agent-modules/`
turns that richer structure into the plain kernel `AgentConfig`: a system
prompt, `ToolSchema[]`, and compact `agentModule` metadata.

Tool execution uses the same rendered metadata. `loop.ts` delegates tool calls
to `dispatchConfiguredTool()`, which routes `executionKind: 'executor'` tools to
the executor and resolves `executionKind: 'host'` handlers through the sealed
registry. Registration rejects duplicate extension IDs and duplicate handler
ownership. Startup seals the registry before sessions run, so runtime behavior
cannot mutate midway through a session. The historical `websearch` routing
compatibility rule remains in the dispatcher for persisted sessions.

The session header stores the rendered module metadata. On session creation, the
host also writes `agent-module/system-prompt.txt` and
`agent-module/tool-registry.json` artifacts beside the JSONL log so a run can be
audited or reproduced without reconstructing startup state from code.
