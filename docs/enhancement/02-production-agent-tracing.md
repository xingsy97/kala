# Production Agent Tracing

Status: proposed high-priority enhancement  
Priority: 2

## Why This Matters

Agent systems fail through bad context assembly, wrong tool schemas, provider
adapter mistakes, hidden retries, latency spikes, and tool execution errors.
Console logs are insufficient because they are flat, unstructured, hard to
correlate, and rarely preserve the exact LLM request/response boundary.

The production target is a trace that can answer: what task was run, which model
request was sent, which tools were advertised, what the model returned, which
tool calls executed, how long each step took, what failed, what was redacted,
and how this run scored in eval.

## Production References

- OpenTelemetry GenAI semantic conventions:
  `https://github.com/open-telemetry/semantic-conventions-genai`
- OpenInference trace spec:
  `https://arize-ai.github.io/openinference/spec/`
- Phoenix observability and evaluation platform:
  `https://github.com/Arize-ai/phoenix`
- LangSmith tracing/evaluation SDK:
  `https://github.com/langchain-ai/langsmith-sdk`
- Codex reference includes an OpenTelemetry integration under
  `references/codex/codex-rs/otel/`.

Key production detail: OpenTelemetry GenAI explicitly treats prompts, messages,
tool definitions, and outputs as sensitive and often large. Full content should
be opt-in or stored externally with trace references, not blindly attached to
every telemetry span.

## Design Principle

Use OpenTelemetry/OpenInference-compatible spans as the export model. The
existing JSONL event log remains the replay ledger, but it is not the production
trace schema.

## Trace Shape

For one user turn or one benchmark instance:

```text
agent.invoke                                  span kind: Agent or Chain
  prompt.assemble                            span kind: Prompt
  gen_ai chat <model>                         span kind: LLM / CLIENT
  execute_tool read                           span kind: Tool
  execute_tool bash                           span kind: Tool
  gen_ai chat <model>                         span kind: LLM / CLIENT
  evaluator.swebench                          span kind: Evaluator
```

Recommended span mapping:

- Session/turn root: OpenInference `AGENT` or `CHAIN`.
- LLM API call: OTel GenAI inference client span.
- Message assembly: OpenInference `PROMPT` span.
- Tool execution: OTel GenAI `execute_tool` span and OpenInference `TOOL` kind.
- Memory/retrieval: OTel GenAI memory/retrieval spans when those features exist.
- Eval: OTel GenAI `gen_ai.evaluation.result` event or OpenInference
  `EVALUATOR` span.

## Required Span Attributes

Use standard attributes when possible:

- `gen_ai.operation.name`: `chat`, `execute_tool`, `retrieval`, `search_memory`,
  `invoke_agent`, or `plan`.
- `gen_ai.provider.name`: `openai`, `anthropic`, `azure.ai.openai`, etc.
- `gen_ai.request.model` and `gen_ai.response.model`.
- `gen_ai.request.stream`.
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, cache token fields,
  and reasoning token fields when available.
- `gen_ai.response.finish_reasons`.
- `gen_ai.response.time_to_first_chunk` for streaming.
- `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`.
- `error.type` on failures.

Project-specific attributes should be namespaced, low-cardinality where
possible, and clearly documented:

- `agent_kernel.session_id`
- `agent_kernel.event_seq`
- `agent_kernel.workspace_id`
- `agent_kernel.run_id`
- `agent_kernel.eval.instance_id`
- `agent_kernel.compaction.applied`

## Full Request and Response Capture

The dashboard needs to show exact API calls for debugging, but production traces
should not leak secrets. Use a two-tier model:

1. Span attributes contain safe metadata and optional truncated previews.
2. Full request/response bodies are stored in a content-addressed artifact store
   with redaction applied. Spans carry references to those artifacts.

The artifact should include:

- Provider adapter name.
- Redacted URL path and provider name, but not full base URL.
- Request headers with credentials removed.
- Request body exactly as sent to the provider after adapter translation.
- Response body exactly as received, including tool call structures.
- Streaming chunk metadata if streaming.

Do not show internal UI-only fields such as `callSeq` as if they were provider
request body fields. UI sequence numbers belong in display metadata, not inside
the captured API body.

## Redaction Policy

Default redactions:

- API keys and authorization headers.
- Full provider base URLs; keep provider family and route path only.
- Local absolute paths outside the active workspace root.
- Environment variables and shell command outputs matching secret patterns.
- Large binary/image/base64 content, replaced by digest and size.

Redaction must be deterministic and tested. The dashboard should label content
as `redacted`, `truncated`, or `not captured` instead of silently omitting it.

## Relationship to JSONL Event Log

The JSONL event log remains authoritative for replay. Trace spans are derived
observability artifacts. This avoids contaminating the kernel protocol with
vendor telemetry concerns.

Recommended linkage:

- Each event line may keep minimal `llmTrace` metadata and artifact references.
- A trace exporter reconstructs spans from JSONL plus host-side timing records.
- Live spans can also be emitted during execution, but replayed export must be
  able to produce equivalent trace topology from persisted artifacts.

The first implementation layer is `@agent-kernel/shared/enhancement`: it exports
redaction helpers, artifact references, message-assembly summaries, and an
OpenTelemetry/OpenInference-shaped span projection from session log entries.
Host code uses this layer when persisting provider-body artifacts, so redaction
happens before disk write and trace spans keep stable links back to `sessionId`
and event `seq`.

Implemented local export command:

```bash
agent-kernel-host enhancement trace export-session \
  --root-dir runs/enhancement \
  --session-log ~/.agent-kernel/sessions/<session>.jsonl \
  --run-id smoke-001 \
  --eval-instance-id sympy__sympy-20590
```

The command writes:

```text
runs/enhancement/
  traces/<session_id>.openinference.json
  llm/<session_id>/<seq>.request.json
  llm/<session_id>/<seq>.response.json
```

Request and response artifacts are redacted before persistence. The trace
artifact is derived from the JSONL ledger and does not participate in replay.

The live host can also write message assembly artifacts before each LLM call
when `artifactRootDir` is configured. The CLI enables this by default under
`~/.agent-kernel/artifacts`; set `AGENT_KERNEL_ARTIFACTS_DIR=0` to disable it or
set `AGENT_KERNEL_ARTIFACTS_DIR=/path` to choose another location. These files
show message count, tool registry size, estimated token contribution by role,
and preflight compaction stages without changing the kernel event protocol.

## Dashboard Changes

The LLM API modal should have two primary tabs:

- `Message Assembler`: assembled kernel messages, system instructions, tool
  registry payload, compaction markers, token estimates, and message/token
  contribution breakdown.
- `API Call`: left request, right response, both showing captured provider body
  artifacts with redaction labels.

Avoid redundant display. The API body appears once. Assembly shows how the
internal context was built before provider translation.

## Export Targets

Minimum viable targets:

- Local OTLP JSONL for test snapshots and dashboard import.
- OTLP HTTP/gRPC endpoint for OpenTelemetry collectors.
- Phoenix/OpenInference-compatible export.

LangSmith can be a later exporter if team workflow requires it, but the primary
open standard path should be OpenTelemetry/OpenInference.

## Testing Plan

- Unit test event-to-span mapping.
- Unit test redaction of base URLs, headers, paths, and secrets.
- Snapshot test captured API request body for OpenAI-compatible and Anthropic
  adapters.
- Integration test that a session with one LLM call and one tool call exports a
  root span, LLM span, and tool span with parent-child IDs.
- Browser test that the LLM API modal shows captured request/response and does
  not show fake provider-body fields.

## Non-Goals

- Do not turn the kernel event log into an OTLP implementation.
- Do not attach full prompts to telemetry by default.
- Do not invent a custom trace format as the primary artifact.
- Do not require Phoenix, LangSmith, or any cloud service to run locally.
