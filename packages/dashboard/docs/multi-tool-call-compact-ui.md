# Multi-tool activity compact UI

## Problem

Assistant turns often contain dense tool activity: reads, searches, edits, shell
checks, and follow-up reads can arrive as a long uninterrupted sequence. Rendering
each call as an equally large row creates three problems:

1. The transcript becomes a wall of repeated tool chrome, especially after many
   successful edits or searches.
2. Important states such as failure, running, or approval requests lose visual
   priority because they compete with routine success rows.
3. Mixed tool runs are still noisy if grouping only handles "same tool repeated".

The dashboard must keep the protocol transcript intact while rendering contiguous
tool work as compact, scannable activity.

## Design goals

- Preserve every underlying `tool_call` and `tool_result`; grouping is a render
  view-model only.
- Keep ordinary small runs readable without forcing extra clicks.
- Collapse noisy long runs even when they contain different tool names.
- Make failed, running, and approval states visible from the collapsed row.
- Reuse tool-specific summary renderers for expanded details.
- Avoid card-per-call layouts for dense successful activity.

## Source of truth

The implementation lives in:

- `packages/dashboard/src/features/chat/grouping.ts`
- `packages/dashboard/src/features/chat/ChatPanel.tsx`
- `packages/dashboard/src/features/chat/toolSummaries/*`
- `packages/dashboard/src/features/chat/NestedTranscript.tsx`

This document describes the intended behavior those files should maintain.

## Activity detection

The dashboard has two render-only grouping passes because tool calls can arrive
in two shapes:

1. A single assistant message can contain several consecutive `tool_call` content
   blocks.
2. The timeline can contain many small alternating items, usually
   `llm_response(tool_call)` followed by `tool_result`, repeated for each tool
   call.

Both shapes must render with the same compact activity UI. The grouping pass must
not merge protocol messages, rewrite the timeline, or change persisted state.

### Transcript-level runs

Before virtualization, `ChatPanel` scans visible transcript items and detects
split tool activity across timeline item boundaries. This pass exists for real
streaming runs where every tool call is emitted as its own `llm_response` event.

A transcript-level run may include:

- Assistant message items whose content is only `tool_call` blocks.
- Immediately following tool result message items whose every `tool_result.callId`
  belongs to a tool call already seen in the run.

The run continues when the next transcript item is another pure tool-call
assistant message, optionally followed by matching tool results.

The run ends at any of these boundaries:

- User message.
- Pending local user message.
- Compact boundary or compact feedback row.
- Assistant text, thinking, image, or any assistant message that mixes tool calls
  with non-tool content.
- A tool result item for an unknown call id or with non-result content.

Only mixed transcript-level runs with at least four calls collapse into one
`Tool activity` row. Shorter runs fall back to the normal per-message rendering.
Same-tool split runs also fall back to the normal compact call/result rows unless
a future design explicitly adds a same-tool transcript-level rollup.

### Message-level runs

Inside one assistant message, a tool activity run is a contiguous sequence of
`tool_call` content blocks. The run ends at the first non-tool content block,
such as assistant text, thinking, or image content. Tool results are not part of
the assistant message; they are looked up separately by `callId` and rendered
inline with the corresponding call.

Example:

```text
assistant text
tool_call read
tool_call grep
tool_call edit
tool_call bash
assistant text
tool_call read
```

This produces two message-level tool activity runs: the mixed four-call run,
then the final single `read` run.

## Collapse threshold

The dashboard uses two different behaviors:

- Same-tool runs are grouped into a compact tool group at any length, including a
  single call. This preserves the existing combined call/result row behavior.
- Mixed-tool runs are collapsed into one `Tool activity` block only when the
  contiguous run has at least four calls.
- Mixed-tool runs shorter than four calls are split back into same-tool compact
  rows. Two or three mixed calls usually contain enough useful intent that hiding
  them behind one generic activity row is not worth the extra interaction.

The threshold is intentionally UI-only. It must not affect timeline data,
protocol messages, persistence, or replay.

## Collapsed row

A collapsed mixed activity row should answer four questions without expansion:

```text
Tool activity · read 2, grep 3, edit 4, bash 1 · 10 ops · 1 failed · 9 succeeded
```

Required content:

- Label: `Tool activity` for mixed groups; the tool name for same-tool groups.
- Tool mix: ordered by first appearance in the run, formatted as `name count`.
- Operation count: `N ops` for mixed groups, `x N` for same-tool groups.
- Lifecycle badges: approval, running, failed, succeeded counts.

State badge priority is:

1. `Needs approval`
2. `Running`
3. `Failed`
4. `Succeeded`

Failures, approval, and running must remain visible while collapsed. Successful
items can be lower contrast.

## Expanded details

Expanded mixed activity is a dense list, not one large card per operation.

Each row is rendered by the call's actual tool renderer and prefixed with the
tool name:

```text
read · /repo/src/ChatPanel.tsx        240 lines
grep · /tool_call/                   8 hits in /repo
edit · /repo/src/ChatPanel.tsx       edited
bash · pnpm test                     failed
```

Clicking a detail row expands the existing full `ToolCallBlock` and
`ToolResultBlock` for that specific call. This keeps deep debugging available
without making the default transcript heavy.

For same-tool groups, detail rows continue to use the existing tool-specific
renderers without repeating the tool name in every primary label.

## Live tail reveal

A collapsed mixed `Tool activity` can still be hard to follow while the agent is
actively issuing more tool calls. During a live run, the dashboard automatically
shows a sliding tail of the latest summary rows while keeping older rows hidden.

The user-facing setting is named `Live tool activity tail` under Settings ->
Interface. It is stored locally in `localStorage` as
`ak-live-tool-activity-tail-count`.

Rules:

- Default value: `3`.
- Allowed range: `0` to `10`.
- `0` disables automatic live reveal; mixed activity stays fully collapsed until
  the user opens it.
- The setting only affects mixed `Tool activity` groups that still have at least
  one running call, meaning a call without a result and without a pending
  approval.
- The UI reveals summary rows only, not full tool input/result bodies.
- As the group grows, the visible window slides forward. With value `3`, calls
  1-3 are hidden after calls 4-6 arrive; rows 4-6 remain visible.
- Manual expansion takes precedence and shows all rows. Pending approvals also
  remain visible even if they are outside the live tail.
- The setting is render-only. It must not affect timeline data, persisted state,
  replay, or compaction.

## Result hiding

When an assistant tool call is represented by a grouped row, the matching `tool`
message result is hidden from the main transcript. The result remains available in
the grouped detail and is matched by `callId`.

This avoids blank tool-result rows and duplicate output while preserving the
underlying message stream.

For transcript-level groups, all consumed `tool_result` items are hidden from the
virtualized transcript wrapper as well as from `MessageRow`. This matters because
leaving empty tool result rows in the virtual list still creates visible vertical
gaps even when the row component returns `null`.

## Nested transcript behavior

Nested sub-agent transcripts use the same grouping rules, but render them more
densely. Mixed activity details must show the actual per-call tool label instead
of the synthetic `Tool activity` label.

## Non-goals

- Do not introduce new protocol event kinds.
- Do not merge, rewrite, or drop tool calls in kernel state.
- Do not make timeline anchors depend on collapsed row text.
- Do not add tool-specific renderers unless a tool needs a materially better
  summary than the generic input preview.

## Test expectations

The dashboard tests should cover:

- Single tool calls render as one combined compact call/result row.
- Same-tool consecutive calls group together.
- Mixed runs of four or more calls collapse to one `Tool activity` row.
- Mixed runs split across repeated `llm_response(tool_call)` and `tool_result`
  transcript items collapse to the same `Tool activity` row.
- Short mixed runs remain separate compact rows.
- Assistant text, compact boundaries, pending user messages, and unrelated tool
  results break transcript-level grouping.
- Collapsed mixed rows expose tool mix, operation count, failures, running state,
  approvals, and success counts.
- Expanded mixed rows use each call's actual tool renderer.
- Matching tool results are hidden from standalone tool-result rows.
