# Dashboard UI Upgrades: 2026 Batch

This document lists eight independent UI upgrades ordered by expected value. Each item should be reversible on its own. Structural changes are scheduled before visual polish so later changes touch fewer mount points.

This document is also the acceptance contract: each section's interface and test list define what the implementation PR must satisfy.

## Global Rules

- Prefer copied single-file components in the shadcn style over broad package dependencies.
- Every visual animation must respect `prefers-reduced-motion`; no-animation mode must preserve functionality.
- Every item must add or update tests using the existing Testing Library plus Vitest pattern.
- Historical line numbers are orientation only. Implementation should use nearby symbols and file anchors, not fixed line numbers.
- Rollout order: 1 -> 3 -> 2 -> 6 -> 4 -> 5 -> 7 -> 8.

## 1. Virtualized Transcript with `react-virtuoso`

### Current State

`ChatPanel` directly maps `transcriptItems`, so every message stays mounted. Long sessions with many messages or large diffs can cause scroll and tab-switch jank. Auto-follow was previously owned by app-level scroll calculations against a Radix scroll viewport, and highlight-jump used DOM ids plus `scrollIntoView`. `NestedTranscript` had the same `.map()` behavior inside a fixed-height `ScrollArea`.

### Goal

- Keep only viewport-relevant rows mounted regardless of message count.
- Support dynamic row heights.
- Preserve pinned-to-bottom behavior: follow output when pinned, do not move when unpinned.
- Preserve highlight jump to a selected message index.
- Apply the same pattern to nested transcripts.

### Interface

Add `packages/dashboard/src/features/chat/VirtualTranscript.tsx`:

```typescript
type Props<Item> = {
  items: readonly Item[]
  renderItem: (item: Item, index: number) => JSX.Element
  keyFor: (item: Item, index: number) => string | number
  pinnedToBottom: boolean
  onPinnedChange: (pinned: boolean) => void
  highlightIndex?: number | null
  footerSlot?: JSX.Element | null
}
```

`ChatPanel` keeps its public API stable but replaces direct `.map()` rendering with `VirtualTranscript`. App-level code owns the pin state and reset signal; the virtual transcript owns the scroll container. `NestedTranscript` follows the same internal pattern and relies on its parent for fixed height.

### Implementation Notes

- Add `react-virtuoso` as a direct dependency.
- Use `atBottomStateChange` to report pin changes.
- Use `followOutput` for pinned auto-follow.
- Use `virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })` for highlight jumps.
- Preserve `id="msg-${index}"` where needed for anchors, but stop depending on it for scrolling.
- Provide a rough `defaultItemHeight` to reduce first-measurement jitter.
- In tests, mock or polyfill the virtualizer APIs that jsdom lacks.

### Tests

- Long transcript renders through the virtualized wrapper rather than a plain `.map()` list.
- `pinnedToBottom=true` plus new output scrolls to the bottom.
- `highlightIndex` calls `scrollToIndex`.
- `footerSlot` renders after items.
- Nested transcripts still render long lists.

### Risk

Dynamic height measurement can briefly shift on first paint. A good default height and memoized markdown rendering reduce the visible impact.

## 2. Cmd/Ctrl+K Command Palette

### Current State

Actions are spread across sidebar menus, header menus, composer selects, and slash commands. There is no global keyboard command surface. Slash commands only exist inside the composer and include a small fixed set.

### Goal

- Cmd/Ctrl+K opens a global palette.
- Fuzzy search all registered actions.
- Group commands by Session, Workspace, Runtime, Composer, and View.
- Closing restores focus to the previously focused element.
- Slash commands remain available and should derive from the same registry where practical.

### Interface

Add a command registry:

```typescript
export type Command = {
  id: string
  group: 'Session' | 'Workspace' | 'Runtime' | 'Composer' | 'View'
  label: string
  hint?: string
  icon?: LucideIcon
  keywords?: readonly string[]
  shortcut?: readonly string[]
  run: () => void | Promise<void>
  when?: () => boolean
}

export type CommandRegistry = {
  register: (command: Command) => () => void
  list: () => readonly Command[]
}
```

Add `features/palette/CommandPalette.tsx` around `cmdk`. App-level actions register commands at the top level. Palette code must only call `command.run()` and must not contain business logic.

### Implementation Notes

- `cmdk` is the intended dependency and matches the shadcn ecosystem.
- Register a document-level keydown listener for Cmd/Ctrl+K.
- Avoid hijacking text inputs and textareas.
- Store `document.activeElement` before opening and restore it after closing.
- Display shortcut labels using platform-aware `⌘` or `Ctrl`.

### Tests

- Cmd/Ctrl+K opens and Escape closes.
- Search filters by label and keywords.
- Enter runs the selected command.
- Disabled or unavailable commands respect `when()`.
- Register/unregister lifecycle is deterministic.
- Focus returns to the previously focused element.

### Risk

Global keyboard listeners can conflict with input editing. Restrict interception to non-input targets.

## 3. Sonner Toast Notifications

### Current State

Session errors have a persistent red banner and connection state is mostly a small header indicator. Sub-agent completion, background shell exit, and approval arrival can be missed if the user is reading another part of the UI.

### Goal

Use toasts for transient events while keeping persistent session errors in the existing banner.

Initial trigger points:

- Disconnect and reconnect.
- Sub-agent completion or failure.
- Background shell exit.
- Approval required.

### Interface

Add a local wrapper, not direct Sonner imports at call sites:

```typescript
export type NotifyKind = 'info' | 'success' | 'warning' | 'error'

export const notify = {
  info(message: string, options?: NotifyOptions): void,
  success(message: string, options?: NotifyOptions): void,
  warning(message: string, options?: NotifyOptions): void,
  error(message: string, options?: NotifyOptions): void,
}

type NotifyOptions = {
  description?: string
  action?: { label: string; onClick: () => void }
  duration?: number
  id?: string
}
```

Mount the toaster at the app root using the project-standard position and theme.

### Implementation Notes

- Socket disconnect should warn; reconnect after a previous disconnect should succeed.
- Approval toasts should dedupe by approval call id.
- Sub-agent toasts should include agent type and duration when available.
- Background shell toasts should provide a View action when the panel can be opened.

### Tests

- `notify.*` maps to the underlying toast implementation.
- Replayed events with the same id do not duplicate.
- Disconnect/reconnect emits expected notifications.
- Approval count transition emits one toast for a new call id.

### Risk

Toasts can become noisy if tied to replayed session history. Use stable ids and transition-based hooks.

## 4. Animated Border Beam

### Current State

Running sub-agent cards differ mainly by a border color and a small spinner. In dense views, running and completed cards can look too similar.

### Goal

Running cards get a subtle animated border beam. Reduced-motion users fall back to a static border. Completed, failed, and idle cards have no beam.

### Interface

Add `packages/dashboard/src/components/ui/border-beam.tsx`:

```typescript
type Props = {
  className?: string
  duration?: number
  colorFrom?: string
  colorTo?: string
  size?: number
}
```

The output is an absolute, pointer-events-none decorative layer. The parent card remains `relative overflow-hidden rounded-*`.

### Implementation Notes

- Do not add Motion for this effect. Use CSS conic gradients and keyframes.
- Respect `prefers-reduced-motion` by disabling or not rendering the animated layer.
- Keep the component purely decorative.

### Tests

- The beam renders for running sub-agent cards.
- Completed and failed cards do not render it.
- Reduced-motion mode disables the animated layer.

### Risk

Low. The component is decorative and must not affect layout.

## 5. Number Ticker

### Current State

Some counts jump instantly, such as task counts, shell counts, turn counts, and benchmark scores. A ticker can help in milestone moments but is distracting in dense tables.

### Goal

Tween only meaningful milestone numbers, especially final benchmark completion scores. Do not animate every table cell.

### Interface

Add a small hook:

```typescript
export function useNumberTicker(
  target: number,
  options?: { durationMs?: number; disabled?: boolean },
): number
```

The hook returns an integer value. When the target increases, it tweens with `requestAnimationFrame`; when the target decreases, it jumps immediately to avoid odd backwards animation. Reduced-motion returns the target immediately.

### Implementation Notes

- Use `easeOutCubic`.
- Store start time, from value, and target in refs.
- Cancel animation frames on unmount.
- Prefer a small `Ticker` component if many call sites need the hook.

### Tests

- Mid-animation values are between start and target.
- End value equals target after duration.
- Decreases jump immediately.
- Reduced-motion jumps immediately.

### Risk

Low if limited to milestone surfaces.

## 6. View Transitions API Wrapper

### Current State

Some hard switches, such as inspector tabs, sub-agent expansion, and workspace/session changes, happen without a transition. Dialogs already have Radix behavior and do not need this.

### Goal

Use the browser View Transitions API where supported, with no-op fallback elsewhere.

### Interface

Add `packages/dashboard/src/lib/viewTransition.ts`:

```typescript
export function withViewTransition(fn: () => void): void
```

Implementation should check `document.startViewTransition`. When available, run the update inside `flushSync` so the browser captures the before/after DOM. When unavailable, run the callback directly.

### Implementation Notes

- Add a small global CSS duration override for root view transitions.
- Do not wrap Radix dialog open/close.
- Use around inspector tab switches, sub-agent open toggles, and deliberate workspace/session switches.

### Tests

- Fallback path calls the function immediately.
- Supported path calls `startViewTransition` and executes the callback.
- A representative tab switch calls the wrapper.

### Risk

Only supported browsers see the effect. Unsupported browsers retain existing behavior.

## 7. Streamdown for Streaming Markdown

### Current State

Streaming text is rAF-batched into `streamingText`, and completed assistant messages use `react-markdown` plus `remark-gfm`. It was unclear whether incomplete streaming markdown fences or emphasis markers caused visible flicker.

### Goal

Do not add `streamdown` unless measurement proves the currently streaming bubble visibly flickers or parses too slowly. Completed messages stay on `react-markdown`.

### Interface

Before implementation, run a real long streaming output and capture evidence. If flicker exists, add `StreamingMarkdown.tsx` and use it only for the active streaming bubble.

### Tests If Implemented

- Unclosed code fence does not crash.
- Unclosed emphasis renders predictably.
- Completed messages still use the existing markdown path.

### Measurement Conclusion

Deferred. After virtualization and memoization, historical bubbles no longer reparse or render when not visible. The remaining active streaming bubble reparses the growing string, but typical provider rates do not make this visually distracting. Revisit only if users report mid-stream layout jumps or provider deltas exceed normal rates.

Suggested temporary instrumentation:

```typescript
const t = performance.now()
useEffect(() => {
  const dt = performance.now() - t
  if (dt > 8) console.warn('slow markdown parse', dt.toFixed(1), 'ms', text.length, 'chars')
})
```

If p95 parse time exceeds one frame for streamed lengths, revive this item and swap only the streaming bubble renderer.

## 8. Shiki Syntax Highlighting

### Current State

Markdown code blocks render as plain `pre` content, and `DiffPreview` already has a planned syntax-highlighting follow-up. There is no global Prism, highlight.js, or Shiki dependency.

### Goal

- Highlight markdown code blocks with Shiki.
- Match light and dark themes.
- Lazy-load languages where practical.
- Fall back to plain text for unknown languages.
- Reuse the same path for diff previews when possible.

### Interface

Add `packages/dashboard/src/features/chat/CodeBlock.tsx`:

```typescript
type Props = {
  code: string
  lang?: string
}
```

Use the markdown `code` renderer to distinguish inline code from fenced blocks via `language-*` class names. Blocks use `CodeBlock`; inline code keeps the existing style.

### Implementation Notes

- Add `shiki` and use the web bundle.
- Keep a single global highlighter instance in a helper module.
- Prefer dual-theme CSS variables so theme switches do not require re-highlighting.
- Show raw code while highlighter setup loads.
- Mock Shiki in jsdom tests.

### Tests

- Known language renders highlighted HTML.
- Unknown language falls back to plain code.
- Unmount during async highlight does not set state.
- Assistant markdown routes fenced code through `CodeBlock`.

### Risk

Shiki can increase payload size. Defer it until the structural UI work is stable.

## Rollout Order

| Order | Item | Reason |
| --- | --- | --- |
| 1 | Virtualized transcript | Stabilizes the central rendering structure before other changes. |
| 2 | Sonner toast | Independent and provides feedback plumbing for later actions. |
| 3 | Cmd/Ctrl+K palette | Benefits from transcript scroll APIs and notification plumbing. |
| 4 | View transitions | Can wrap palette and tab state changes after command actions exist. |
| 5 | Animated border beam | Isolated sub-agent decoration. |
| 6 | Number ticker | Small numerical polish after sub-agent/task surfaces are stable. |
| 7 | Streamdown | Measurement-gated and likely unnecessary. |
| 8 | Shiki | Highest payload risk; do it last. |

Each item should remain independently revertible.
