# Roadmap · Part C · Streaming and latency (2-week delivery)

## C.1 End-to-end streaming tokens

**Goal**: the current kernel loop is synchronous — tool calls complete before tokens flush. Switch to SSE so LLM tokens stream character-by-character and tool-call partial args also appear incrementally in the dashboard.

**Why it matters**: end-to-end streaming is table stakes for any interactive agent runtime. Without a real streaming loop and TTFT metrics, there is nothing to optimize and no basis for latency claims.

**What to do**:

- `packages/host/src/loop.ts` introduces `AsyncIterable<LoopEvent>` as the main output channel.
- `packages/host/src/http/sse.ts`: new SSE endpoint `/session/:id/stream`.
- Dashboard chat panel consumes SSE, tokens render as they arrive, tool call args also stream in.
- **Surface TTFT (time-to-first-token) and tokens/s live metrics** in the RuntimeMetrics panel.
- Add `docs/streaming-architecture.md`: backpressure / error / reconnect semantics across kernel → host → SSE → dashboard.

**Acceptance**: open chat panel, send a message, first token renders within 200ms, RuntimeMetrics panel shows TTFT=XXms, tokens/s=YY.
