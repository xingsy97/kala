# Model and Tool Router

Status: proposed enhancement  
Priority: 6

## Why This Matters

Production agents rarely use one static model and one static tool set for every
step. They route by task type, cost, latency, context size, tool risk, and
provider health. The value is not a fancy state machine; it is controlled
policy, observability, and fallback behavior.

## Design Principle

Routing is a host concern. The kernel emits `call_llm` and `call_tool` effects;
the host decides which provider/model endpoint or executor capability satisfies
the effect.

## Model Routing Inputs

Use only data already available outside the reducer:

- Requested model from user/session settings.
- Task classification from host-side heuristics or a cheap classifier.
- Context length and compaction pressure.
- Required modalities: text, image, tool calling, reasoning budget.
- Provider health and rate-limit state.
- Cost and latency budget.
- Eval experiment config.

## Routing Outputs

The router should produce a structured decision artifact:

```json
{
  "selectedProvider": "openai",
  "selectedModel": "gpt-5.5",
  "reasonCodes": ["user_selected", "supports_tool_calling"],
  "fallbacks": ["anthropic:claude-..."],
  "budget": { "maxInputTokens": 120000, "maxOutputTokens": 8192 }
}
```

This artifact is logged for observability and eval comparisons. It is not added
to kernel state.

Implemented host artifact capture writes this decision before each LLM call when
`artifactRootDir` is enabled:

```text
<artifactRoot>/router-decisions/<session_id>/<event_seq>.json
```

The decision artifact records selected/requested model, inferred provider or
router adapter, reason codes, context budget, and tool visibility policy. Tool
policy includes total visible tools, approval-gated tool count, skill-backed
tool count, and whether sub-agent or memory tools were available to that LLM
call. It is observability-only: the actual model call path remains the existing
host router, and replay still comes from the JSONL event ledger.

## Tool Routing

The current tool registry lives in executor/host boundaries. Production-level
tool routing should add:

- Capability discovery by workspace and executor.
- Tool schema versioning.
- Tool visibility policies by approval mode and benchmark mode.
- Stale tool registration rejection.
- Clear marking of skill-backed tools in dashboard tool lists.
- Tool result size limits and overflow artifacts.

## Skill-Backed Tools

For opencode-style skills exposed as tools:

- Skill metadata becomes a tool schema advertised to the model.
- Invocation is an ordinary tool call.
- The executor/host expands the skill instructions privately when executing.
- Dashboard marks the tool as `skill-backed` and links to skill metadata.

This is easier to debug than hidden natural-language skill selection because the
LLM response contains the tool name and arguments.

Implemented tool catalog artifacts make this explicit without changing
`ToolSchema`:

```text
<artifactRoot>/tool-catalog/<session_id>/<event_seq>.json
```

Each entry records tool name, approval policy, kind (`executor`, `host`,
`skill_loader`, `sub_agent`, or `unknown`), whether it is skill-backed, and a
schema hash. The dashboard can consume this artifact instead of inferring
skill-backed tools only from names or descriptions.

## Fallbacks and Retries

Retries should be typed:

- Retry transient provider errors with exponential backoff and jitter.
- Do not retry deterministic schema validation failures without changing input.
- Fallback to another provider only if the target model supports required
  features.
- Record every retry/fallback as trace events and router artifacts.

## Testing Plan

- Unit tests for routing decisions under provider outage, context overflow, and
  tool-required tasks.
- Contract tests for skill-backed tool schemas.
- Implemented artifact tests for router decisions, tool visibility policy, and
  skill-backed tool catalog metadata.
- Integration test that a failed provider call records retry and fallback spans.
- Dashboard test that skill-backed tools are visibly marked.

## Non-Goals

- Do not add router decisions to reducer state.
- Do not let router fallback change benchmark configs silently.
- Do not hide tool schema changes from traces.
