# Chat Panel UX Design

This document records the recent chat-panel redesign decisions for the center column. Future changes should start here instead of reconstructing intent from git history.

The main threads are:

1. Streaming smoothness: requestAnimationFrame batching, memoization, and an adaptive typewriter smoother.
2. Auto-scroll to bottom: pinned-to-bottom behavior that users can interrupt.
3. Composer and approval flip: an X-axis 3D flip between composer and approval review.
4. Tasks button: a compact composer utility instead of a persistent transcript panel.
5. Image content preview: borderless thumbnails plus modal enlargement.

## 1. Streaming Smoothness

### Problem

The previous implementation appended each `text_delta` directly to React state with `setStreamingText(prev => prev + p.text)`. Every state update rerendered `ChatPanel`, and every historical assistant bubble ran through markdown parsing again.

Observed behavior:

- Backend chunks could arrive around 80 times per second, causing roughly 80 `setState` calls per second.
- Each update rerendered `ChatPanel`; every assistant bubble went through `AssistantMarkdown`, `remark`, `rehype`, and HTML rendering.
- Cost grew linearly with historical message count.
- Visually, text appeared to jump rather than flow.

### Measures

1. **requestAnimationFrame batching** in `session.ts`. Deltas are written to `streamBufferRef`; one `requestAnimationFrame` drains part of the buffer and performs one state update. Multiple deltas landing in the same browser frame are merged automatically, so UI update frequency is capped by the display frame rate instead of packet frequency.
2. **Adaptive typewriter smoother**. Each frame drains `max(2, ceil(backlog / 10))` characters and keeps scheduling animation frames until the buffer is empty.
   - Small backlog: two characters per frame keeps slow output from feeling mechanical.
   - Large backlog: draining 10% per frame catches up without lagging indefinitely.
3. **`React.memo` on `AssistantMarkdown`** in `ChatPanel.tsx`. Historical message text does not change, so historical markdown parsing is skipped. Only the current streaming bubble rerenders on each frame.

The critical code path is `session.ts`: `drainStreamBuffer`, `pushStreamDelta`, and `resetStream`. All streaming resets, including turn end, error, and fork, must go through `resetStream()` rather than direct `setStreamingText('')`; otherwise residual buffered text can leak into the next turn.

## 2. Auto-Scroll to Bottom

Users reading earlier history should not be forced to the bottom by new messages. If they are already at the bottom, new messages should follow automatically.

The original rule was owned by `pinnedToBottomRef` in `app.tsx`:

- Initial value: `true`.
- User scrolls more than 64 px away from the bottom: `pinnedToBottomRef.current = false`.
- User returns within 64 px of the bottom: `pinnedToBottomRef.current = true`.
- When `chatItems`, `streamingText`, or `pendingApprovals` changes, scroll to bottom only if pinned.

The 64 px threshold is a tolerance radius for "close enough to the bottom". It avoids flipping the pin state when the user makes small scroll adjustments near the end of the transcript.

The virtualized implementation keeps the same user-visible semantics through `VirtualTranscript`: the virtualizer reports bottom state, the parent owns the current pin flag, and explicit send actions force a jump to the bottom because sending is a clear user signal that the active turn should be visible.

## 3. Composer and Approval Flip

### Previous Behavior

Approval review used to appear as an amber banner above the composer, with stacked action buttons. That had three problems:

- The buttons were far from the input area where the user's attention already was.
- The composer remained visible even though sending a message was not useful during approval.
- Multiple pending approvals stacked into a visually heavy pile.

### Current Behavior

`ComposerFlipContainer` is a 3D flip surface. The front is the normal composer; the back is `ApprovalCard`. When there is a pending approval, the surface rotates 180 degrees around the X axis, similar to a split-flap display.

The X axis is intentional. A Y-axis flip reads like a book page; an X-axis flip reads more like a dashboard panel changing state. The container is wide and shallow, so rotating around the short axis keeps the visual weight stable and preserves the user's horizontal focus line.

Key CSS concepts:

```css
parent: perspective: 1600px;
inner: transform-style: preserve-3d;
inner: transform: rotateX(0deg) | rotateX(180deg);
front: backface-visibility: hidden;
back: backface-visibility: hidden; transform: rotateX(180deg);
```

Height animation uses measured heights for both faces. The outer shell transitions to the active face's measured height over 300 ms. This prevents content from overflowing when the back face is taller.

The hidden face uses `inert` so keyboard focus cannot enter invisible DOM.

### Multiple Pending Approvals

The chosen pattern is a hybrid: one card carousel plus top-level bulk actions.

- The body shows one approval at a time with a `1 of N` indicator and previous/next navigation.
- The top-right controls provide `Reject all` and `Approve all` for batch cases.
- Keyboard behavior: `Enter` approves, `Escape` rejects, and left/right arrows page through approvals.
- The approve button receives persistent autofocus so `Enter` works for the common path.

After an approval is handled, the parent list shrinks and the current index clamps to the new length. The carousel naturally advances to the next pending approval.

The pending tool-call card in the transcript no longer owns the decision buttons. It keeps an amber border and a hint that the action must be reviewed in the composer area. This keeps one primary decision surface and avoids duplicate controls.

## 4. Tasks Button

### Previous Problem

Placing a task list permanently between the transcript scroll area and composer consumed vertical chat space. Tasks are runtime work items surfaced by a normal tool, not a primary chat transcript surface.

### Data Boundary

`todowrite` is a normal executor tool. The kernel reducer does not contain `state.todos` and does not know a special todo protocol.

When the dashboard needs to show tasks, it derives them from the timeline:

1. Find successful `call_tool(name: "todowrite")` calls.
2. Match them with corresponding `tool_result(ok: true)` events.
3. Parse the `todos` array from the tool input for the latest successful call.

Failed calls, pending calls, and malformed inputs do not update the task display.

This boundary keeps the core state machine focused on protocol facts and prevents one tool's semantics from becoming reducer state.

### Design

The composer utility area shows a compact `TasksButton`. It displays a task icon plus `N/M`, where `N` is completed count and `M` is total count. It does not render when there are no tasks.

Clicking opens a popover with the full task list:

- Primary row: task content and status icon.
- Secondary row: priority, only when priority exists.
- Completed tasks use lower contrast.
- In-progress tasks use light emphasis.
- Pending tasks stay neutral.

The popover is a temporary inspection layer. It does not push the transcript layout, consume persistent vertical space, or provide editing and drag behavior.

### Interaction

- Click `TasksButton` to open or close the popover.
- Press `Escape` to close.
- Popover content uses the project's unified `ScrollArea`, not a raw native scrollbar.
- Task updates follow the derived timeline result; the dashboard does not persist separate task state.

### Non-Goals

- Do not write tasks into kernel reducer state.
- Do not edit tasks directly in the UI. The next `todowrite` call is the source of truth; UI edits would create conflicting ownership.
- Do not add reducer lifts, protocol special cases, or compatibility shims for `todowrite`.

## 5. Image Content Preview

`ImageContent` in messages can come from pasted base64 data or workspace file references. The chat panel only displays image content that is already present in the transcript; it does not copy images into separate dashboard state.

Thumbnail rules:

- Keep images within the bubble using `max-w-full` and `object-contain`; they must not widen the chat column.
- Do not draw hard `border` or `border-border/*` frames around thumbnails. The image is content, not a nested card, and hard frames make user bubbles look like wireframes.
- Express clickability with `cursor-zoom-in`, subtle hover background, or shadow, not with a border.
- Clicking opens a modal preview. The modal uses the shared `Dialog` layer with dark backdrop, `bg-background`, `shadow-lg`, and a soft `border-border/60` rim.
- Enlarged images use viewport constraints such as `max-h-[calc(100dvh-8rem)]`, `max-w-full`, and `object-contain`, so mobile viewports do not overflow or hide the close button.
