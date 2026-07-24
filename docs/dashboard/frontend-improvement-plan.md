# Frontend Improvement Plan

> Scope: `packages/dashboard`  
> Status: proposal  
> Focus: modern browser capabilities that improve real dashboard workflows.

This document records frontend improvements that should be implemented as
progressive enhancements where they depend on browser APIs. Unsupported
browsers must keep the current behavior. The browser-capability sections
correspond to items 2-6 from the planning discussion: persistent local cache,
app badging, explicit file saves, background scheduling/workers, and wake
lock/page lifecycle handling. The document also records mobile work-surface
layout fixes that do not require new browser capabilities but must follow the
same dashboard design constraints.

The priority is not visual novelty. The priority is faster session switching,
better long-running monitoring, safer local file export, and less main-thread
jank during large sessions.

## Existing Design Constraints

This plan is subordinate to the existing dashboard and platform design notes:

- `docs/dashboard/browser-feature-todo.md`: modern browser features must not
  increase agent core state-machine or wire-protocol complexity.
- `docs/dashboard/frontend-modernization-plan.md`: the dashboard is a dense
  operational workbench; polish is allowed only when it does not interfere with
  scanning or runtime signals.
- `docs/dashboard/derived-ui-enhancements.md`: dashboard enhancements should be
  derived views over existing durable runtime data.
- `docs/planning/roadmap-notes/pwa-mobile-and-push.md`: Service Worker caching
  must not intercept Socket.IO or host RPC routes. Its "do not cache session
  messages" rule applies to SW route-level/runtime caching, not to an
  application-owned IndexedDB session cache.
- `docs/meta/principles.md`: no UI-only fields in kernel/shared state, no mock
  production paths, and browser-facing UX must stay understandable.

## Cross-Cutting Rules

These rules apply to every section below.

1. **Progressive enhancement only**

   Every browser API must be feature-detected. Unsupported browsers keep the
   current behavior without degraded core functionality.

2. **Dashboard-local only**

   Browser-local state may improve presentation, caching, and local workflow.
   It must not become the source of truth for session state, approvals,
   executor routing, host lifecycle, or agent execution semantics.

3. **No protocol changes for presentation**

   These features should not add fields to `@agent-kernel/kernel`, shared
   protocol messages, or session JSONL. Protocol additions are allowed only if
   they represent real runtime semantics, not browser UI convenience.

4. **Local persistence is sensitive**

   Session transcripts and tool outputs may contain secrets. Any feature that
   stores them beyond the current page lifetime must be visible and manageable
   in settings, partitioned by host, and paired with a clear erase path.

5. **Host partitioning**

   Cache keys and browser-local state must include normalized host endpoint,
   protocol version, and local cache schema version. A future host-provided
   stable `hostId` would be better, but this plan does not require a protocol
   change to introduce one.

6. **Multi-tab safety**

   A feature that writes shared local state or owns global browser UI must be
   correct when multiple dashboard tabs are open. Use BroadcastChannel or Web
   Locks where ownership matters; otherwise avoid destructive clears from stale
   tabs.

7. **Measure before workerizing**

   Web Workers and OPFS add complexity. First add performance marks and size
   thresholds, then move only proven large work off the main thread.

8. **No visual noise in high-frequency surfaces**

   These improvements should not add decorative motion, long prose, or new
   persistent banners to Chat, Explorer, Inspector, or benchmark tables. Status
   should remain compact and quiet.

9. **Mobile controls need explicit priority**

   Narrow viewports must not rely on accidental flex wrapping. Every compact
   toolbar, footer, and popover needs an explicit control priority order:
   critical commands stay visible, secondary commands collapse to icon-only or
   menu entries, and low-priority labels truncate only after their icon and
   action target remain usable.

10. **Overlays must not hide the active command path**

   Mobile popovers, sheets, and dropdowns may cover passive transcript content,
   but they should not obscure the send button, composer input, close/dismiss
   affordance, or the control that opened them. If that cannot be guaranteed,
   use a bottom sheet or full-width anchored panel with a clear dismiss path.

11. **Debug views default to compact disclosure**

   Debugger panels should expose detailed raw state only on demand. Large JSON,
   diffs, traces, and derived debug blocks should default to collapsed when they
   are not the primary signal for the current row. Expansion state may be
   remembered locally, but the first-load default should favor scanability and
   mobile stability.

12. **Settings must not be a squeezed desktop page**

   Settings is a form-heavy operational surface. On mobile it needs its own
   hierarchy for navigation, section titles, summaries, and actions. Desktop tab
   bars, large headings, long descriptions, and card-like information blocks
   must not simply shrink until labels truncate or controls look misaligned.

## 1. Persistent Session Cache with IndexedDB / OPFS

### Motivation

The current session view cache is an in-memory LRU cache. It makes same-tab
session switching fast, but the cache disappears on reload and still consumes JS
heap for large sessions.

Persistent local cache should make these flows faster:

- reload dashboard and immediately see the last known transcript;
- reopen a previously viewed large session without a full history reload;
- keep useful read-only context visible while the host or network is briefly
  unavailable;
- reduce JS heap pressure by moving cold cached session data out of memory.

### Design

This is **not** Service Worker runtime caching. The Service Worker must keep
the existing rule: do not intercept Socket.IO, host RPC routes, or session
event streams. This feature is an application-owned read-through cache for
session snapshots and timeline chunks. It may store session content because the
dashboard owns its own cache invalidation and cursor reconciliation; the host
remains the source of truth.

Default policy:

- keep the current in-memory cache enabled;
- enable durable session cache by default within the configured local cache
  budget, unless the user disables it;
- expose cache usage, clear, and disable controls in settings;
- always offer `Clear local session cache`.

Use a two-tier cache:

- **L1 memory cache**: current `SessionViewCache`, kept for instant same-tab
  switching.
- **L2 IndexedDB cache**: durable session snapshots and timeline chunks across
  reloads.
- **OPFS optional blob store**: only for large binary or artifact blobs where
  IndexedDB JSON is the wrong shape.

Suggested IndexedDB stores:

```typescript
type SessionCacheMeta = {
  namespace: string
  schemaVersion: number
  sessionId: string
  hydratedCursor: number
  updatedAt: number
  estimatedBytes: number
  selectedModel?: string | null
  workspaceId?: string | null
}

type SessionTimelineChunk = {
  namespace: string
  sessionId: string
  fromSeq: number
  toSeq: number
  entries: TimelineEntry[]
  estimatedBytes: number
}

type SessionSnapshot = {
  namespace: string
  sessionId: string
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextUsageSnapshot | null
  queuedMessages: QueuedMessagePreview[]
  lastError: SessionErrorEvent | null
  updatedAt: number
}
```

The `namespace` should be derived from:

- normalized host endpoint;
- dashboard protocol version;
- local cache schema version;
- optional future host identity if the host later exposes one.

Read path:

1. Check L1 memory cache.
2. If L1 misses, check IndexedDB.
3. If IndexedDB hits, render the cached snapshot immediately.
4. After `session:ready`, compare cached cursor with host cursor:
   - cached cursor is behind: request `client:load_history` with `sinceCursor`;
   - cached cursor matches: no full history reload;
   - cached cursor is ahead: drop that session's local cache and do a full
     reload.
5. If the host endpoint or protocol namespace changed, ignore old cache rather
   than trying to migrate it blindly.

Write path:

- Debounce writes after `session:ready`, `server:history`, and
  `server:event_appended`.
- Use background scheduling, not synchronous writes in socket handlers.
- Acquire a best-effort Web Lock before writing a session chunk when available.
  Without Web Locks, make writes idempotent and cursor-monotonic so a stale tab
  cannot overwrite newer chunks.
- Delete L1 and L2 entries when a session is deleted.
- Delete all matching cache records when a workspace is deleted.

Capacity policy:

- Use the existing session cache MB setting as the local cache budget.
- Keep L1 smaller than L2, for example `min(128MB, 25% of budget)`.
- Evict L2 by LRU using `updatedAt`.
- Surface `navigator.storage.estimate()` in settings.
- Offer `Clear local session cache` and `Request persistent storage` actions.
- If persistent storage is denied, keep the feature available but label it as
  browser-evictable cache.

### Implementation Plan

1. Add a small IndexedDB wrapper under `packages/dashboard/src/lib/local-cache/`.
2. Add a local-cache namespace helper and schema version constant.
3. Add a persistent implementation behind the current `SessionViewCache` shape.
4. Wire `useSession` to hydrate from L2 only when L1 misses and durable cache is
   enabled.
5. Add LRU eviction and storage usage reporting.
6. Add settings controls for durable cache, persistent storage, and cache
   clearing.
7. Add tests for cursor reconciliation, eviction, deletion, namespace mismatch,
   multi-tab stale writes, disabled durable cache, and corrupted cache
   recovery.

### Risks

- IndexedDB migrations must be explicit and versioned.
- Large JSON serialization can jank the main thread unless scheduled.
- Multi-tab writes can race; use BroadcastChannel or Web Locks before making
  multiple tabs write the same session aggressively.
- Durable cache can expose sensitive transcript/tool output to anyone with
  browser profile access. The settings UI must state this plainly.

## 2. App Badging API

### Motivation

Desktop notifications are event-based. The dashboard also needs a quiet,
persistent status signal for installed PWA users. App badges are a good fit for
pending human attention.

### Design

The badge count should represent actionable attention, not generic activity.
It is a derived dashboard signal over existing control-plane/session data.
It must not introduce new host state or session log fields.

Count these by default:

- pending approval requests;
- sessions waiting for user input;
- session errors visible in currently loaded dashboard state;
- host disconnected, counted as one item.

Do not count every running session by default. A permanently non-zero badge
would make the signal meaningless.

Wrapper shape:

```typescript
type AppBadgeState = {
  approvals: number
  waiting: number
  errors: number
  disconnected: boolean
}

export function updateAppBadge(state: AppBadgeState): void {
  if (!('setAppBadge' in navigator) || !('clearAppBadge' in navigator)) return

  const count =
    state.approvals +
    state.waiting +
    state.errors +
    (state.disconnected ? 1 : 0)

  if (count > 0) void navigator.setAppBadge(count)
  else void navigator.clearAppBadge()
}
```

Settings should allow:

- enable app badge;
- include approvals;
- include waiting sessions;
- include errors;
- include host disconnected.

Multi-tab ownership:

- If a tab coordinator exists, only the leader tab calls `setAppBadge` and
  `clearAppBadge`.
- Before that exists, the feature may be limited to the active tab and must
  clear its badge on `pagehide`/`beforeunload` to reduce stale counts.
- Never use the badge to imply an exact server-global count. It is a local
  dashboard attention count over loaded data.

### Implementation Plan

1. Add `lib/app-badge.ts` with feature detection and a no-op fallback.
2. Add a pure `deriveAppBadgeState(...)` helper over control-plane state and
   active-session state.
3. Add settings toggles, defaulting to conservative actionable counts.
4. If a tab coordinator exists, only the leader tab updates the badge.
5. Clear badge on unload or when all counted conditions resolve.
6. Add tests for feature detection, count derivation, settings filters,
   unsupported browsers, and unload clearing.

### Risks

- Browser support varies; this must never be required for core operation.
- Count semantics must stay conservative to avoid permanent badge noise.
- Without tab leadership, multiple tabs can produce briefly stale badge counts.
  That is acceptable only if each tab clears on unload and recomputes on focus.

## 3. File System Access API for Explicit Saves

### Motivation

Current downloads use Blob URLs and an anchor click. That fallback is reliable,
but it gives users limited control over save location and can be memory-heavy
for larger exports.

The File System Access API can improve explicit user-triggered saves while
preserving the current fallback for unsupported browsers.

### Design

Add a single save helper:

```typescript
type SaveFileInput = {
  suggestedName: string
  mimeType: string
  blob: Blob
}

type SaveFileResult = 'saved' | 'downloaded' | 'cancelled'
```

Behavior:

1. If `window.showSaveFilePicker` exists, show the native save dialog.
2. Write through `FileSystemWritableFileStream`.
3. If the user cancels, return `cancelled` without showing an error.
4. If unsupported or the picker fails for non-cancel reasons, fall back to Blob
   download.

Keep this strictly user initiated. Agents must not write directly to the
operator's local filesystem.

Security and UX boundaries:

- Do not persist `FileSystemFileHandle` values. Remembering user file handles
  would blur remote workspace files and local operator files.
- Do not add automatic background exports.
- Do not surface raw server paths as default filenames. Use the existing
  user-facing download filename behavior.
- Keep the current Blob-anchor fallback as the compatibility baseline.

Good first surfaces:

- file explorer download;
- view-file modal download;
- session transcript export;
- LLM trace export;
- artifact bundle export.

Future streaming improvement:

- Add a host HTTP download route or file-stream RPC.
- Pipe a `ReadableStream` into `FileSystemWritableFileStream` for large files
  instead of first building a full Blob in memory.

### Implementation Plan

1. Replace `saveBlob` callers with a new `saveFile` helper that keeps the Blob
   fallback.
2. Add MIME/extension normalization for known file types, with safe fallback to
   `application/octet-stream`.
3. Add tests for supported, cancelled, unsupported, permission-denied, and
   fallback paths.
4. Add optional success feedback only for long or explicit exports; ordinary
   file downloads should stay quiet.
5. Later, add streaming download support if large file exports become common.

### Risks

- API support is not universal.
- Persisting file handles is unnecessary and would create confusing local vs.
  remote workspace semantics.
- Large Blob generation can still jank before the streaming route exists.
- The picker API requires a user gesture; callers must invoke it directly from
  click handlers, not from delayed effects.

## 4. Background Scheduling and Workers

### Motivation

Large sessions do significant derived work on the main thread: transcript
grouping, attention timeline computation, task extraction, context estimation,
diff processing, syntax highlighting, and cache-size estimation. These tasks
can compete with typing, scrolling, and session switching.

### Design

Use three layers, in this order:

1. **Scheduling wrapper** for cancellable background tasks.
2. **React transition boundaries** for low-priority UI commits.
3. **Web Workers** only for tasks large enough to justify structured clone
   overhead.

Scheduling wrapper:

```typescript
type ScheduledTask<T> = {
  promise: Promise<T>
  cancel(): void
}

function scheduleBackground<T>(
  run: (signal: AbortSignal) => T | Promise<T>,
): ScheduledTask<T> {
  const controller = new AbortController()
  const promise = new Promise<T>((resolve, reject) => {
    const execute = (): void => {
      if (controller.signal.aborted) return
      Promise.resolve(run(controller.signal)).then(resolve, reject)
    }

    const scheduler = globalThis.scheduler as
      | undefined
      | { postTask(cb: () => void, options?: { priority?: 'background' | 'user-visible' }): Promise<void> }

    if (scheduler?.postTask) void scheduler.postTask(execute, { priority: 'background' })
    else if ('requestIdleCallback' in window) window.requestIdleCallback(execute, { timeout: 500 })
    else window.setTimeout(execute, 0)
  })

  return { promise, cancel: () => controller.abort() }
}
```

Candidate tasks for scheduling first:

- cache byte estimation for large views;
- transcript grouping for large timelines;
- diff summary building for large tool outputs;
- `tasksFromTimeline` and `buildHumanAttentionTimeline` only after measurement
  shows they are material at real session sizes.

Candidate tasks for workers later:

- token/context estimation;
- large transcript derived state;
- large diff parsing;
- search/indexing;
- huge JSON byte estimation.

Worker threshold examples:

- timeline events > 500;
- serialized transcript > 2 MB;
- code/diff block > 200 KB.

Small sessions should stay synchronous to avoid worker overhead.

State model:

- Derived values remain dashboard-local and disposable.
- The UI should keep the last completed derived result while a new background
  computation runs.
- If the user switches sessions, abort old work and ignore late responses by
  request id.
- Workers must not own socket subscriptions, React state, or host RPC calls.

Performance instrumentation:

- Add local-only `performance.mark` / `performance.measure` around session
  switch hydration, transcript derivation, attention derivation, task derivation,
  diff processing, and cache serialization.
- Keep the measurements in developer diagnostics or tests. Do not add noisy
  user-facing metrics to the main dashboard.

### Implementation Plan

1. Add `lib/scheduler.ts` with feature detection, cancellation, and tests.
2. Add performance marks around large-session switching and derived work.
3. Move one measured, low-risk derived computation behind the scheduler.
4. Add request-id based stale-result protection.
5. Introduce one Vite worker only for a measured large pure computation.
6. Keep worker protocol explicit and versioned.

Worker message shape:

```typescript
type WorkerRequest =
  | { version: 1; id: string; kind: 'attention'; sessionId: string; timeline: TimelineEntry[] }
  | { version: 1; id: string; kind: 'tasks'; timeline: TimelineEntry[] }
  | { version: 1; id: string; kind: 'estimate-cache'; value: unknown }

type WorkerResponse =
  | { version: 1; id: string; ok: true; result: unknown }
  | { version: 1; id: string; ok: false; error: string }
```

### Risks

- Structured clone cost can exceed compute savings for small data.
- Async derived state can flicker unless old results remain visible while new
  results compute.
- Worker build configuration must keep shared package imports stable.
- Worker results can arrive after a session switch; request ids and aborts must
  prevent stale data from updating the visible session.

## 5. Wake Lock and Page Lifecycle Handling

### Motivation

The dashboard is often used to monitor long-running agent work. On mobile or
installed PWA, the screen sleeping during a long run is disruptive. At the same
time, background tabs should reduce nonessential work.

### Design

Add an opt-in setting:

- `Keep screen awake while a session is running`

Behavior:

- When enabled and the active session is running, request
  `navigator.wakeLock.request('screen')`.
- Release when the active session becomes idle, the page is hidden, or the user
  disables the setting.
- Re-request on `visibilitychange` when the page becomes visible again and the
  session is still running.

Page lifecycle policy:

- On `visibilitychange: hidden`, pause nonessential animations and expensive
  polling, but do not stop Socket.IO state reconciliation.
- On `pagehide`, schedule best-effort local cache flushes. Do not block unload
  with long writes.
- On `pageshow`, refresh host state and re-check PWA update availability.
- Reacquire Wake Lock only when the page is visible, the setting is enabled,
  and the active session is still running.

UI policy:

- This is a quiet setting, not a persistent warning.
- Show unsupported status only inside settings.
- If Wake Lock is revoked by the system, retry on next visibility/focus event
  rather than spamming the user.

### Implementation Plan

1. Add `lib/wake-lock.ts` with feature detection and release handling.
2. Add a setting under interface or notifications, disabled when unsupported.
3. Wire it to active session running state.
4. Add page lifecycle hooks for cache flush, update checks, and animation/poll
   throttling.
5. Add tests with mocked `navigator.wakeLock`, revocation events,
   `visibilityState`, and unsupported browsers.

### Risks

- Wake Lock requires user activation in some browsers and can be revoked by the
  system at any time.
- It must be opt-in to avoid battery surprises.
- The UI should show capability/status quietly, not as a persistent warning.
- Background lifecycle throttling must not hide real connection loss or pending
  approval states.

## 6. Mobile Composer and Compact Control Layout

### Motivation

The composer is a high-frequency control surface. On mobile, normal composer
mode currently risks becoming visually noisy: the session config popover can
crowd the composer, select values can truncate poorly, footer controls can wrap
into multiple rows, and status indicators compete with send controls. This
creates a worse interaction path precisely where screen width is most limited.

The goal is not a redesign. The goal is a stable mobile layout contract for the
existing composer, config controls, and footer actions.

### Design

Use a compact command-strip model for the mobile composer footer.

Control priority on mobile:

1. send button and send-mode affordance;
2. composer config entry point;
3. active runtime/attention/context indicators that require operator action;
4. background shells and task list entry points;
5. verbose labels such as model name, approval description, and layout help.

Footer behavior:

- The normal composer footer should stay a single row on mobile.
- Critical action groups must be fixed-size and must not be pushed onto a second
  row by optional controls.
- Optional footer extras should live in a shrinkable middle slot. They may
  become icon-only, hide counts behind accessible labels, or move into the
  config menu when there is not enough width.
- Do not show long text labels in the footer below the `sm` breakpoint. Mobile
  footer labels should be icons, short counts, or compact badges.
- Runtime/context/attention indicators must reserve stable dimensions so
  loading, unknown, warning, and numeric states do not shift the send button.
- The footer should be driven by container width where possible, not only global
  viewport width. A narrow side-by-side desktop panel can hit the same pressure
  as a phone.

Session config overlay behavior:

- On mobile, the config surface should be either a bottom sheet or a full-width
  anchored panel with a clear close path. It should not appear as a narrow
  floating card that overlaps the composer footer unpredictably.
- Field rows need a consistent two-level structure: label/status summary above,
  control below. Avoid squeezing a long value, label, and dropdown affordance
  into one row when the viewport is narrow.
- Select trigger content should have a stable layout: primary value truncates
  with ellipsis, provider/secondary text truncates separately, and the chevron
  remains visible.
- Warnings such as approval danger text should fit within the control width and
  should not collide with the selected value.
- The config surface should keep the current dense dashboard style: no large
  cards inside cards, no explanatory prose blocks, and no decorative styling.

Composer body behavior:

- Opening config should not resize the text input unpredictably.
- The input, footer, and send action should remain reachable after opening and
  closing config.
- Focus return should be deterministic: closing config returns focus to the
  config button or composer input depending on the action that closed it.

### Implementation Plan

1. Audit composer footer, config popover, model selector, approval selector,
   layout selector, background shell button, task button, runtime metrics, and
   attention/context indicators as one compact control surface.
2. Define a small responsive layout contract for footer slots:
   `leading config`, `shrinkable extras`, and `fixed trailing actions`.
3. Convert mobile footer controls to a no-wrap row, with optional controls
   allowed to collapse before critical actions wrap.
4. Replace the mobile config popover layout with a bottom-sheet or full-width
   anchored variant while keeping the desktop popover behavior if it remains
   appropriate.
5. Normalize select trigger internals so long model names, provider names, and
   approval summaries truncate predictably.
6. Add visual regression coverage for mobile widths around 320, 375, 390, and
   430 px, plus a narrow desktop container case.
7. Add interaction coverage for opening config, changing model, changing
   approval mode, switching composer layout, sending a message, and dismissing
   the config surface.

### Acceptance Criteria

- The mobile normal composer footer stays on one row at 320 px width.
- The send button and send-mode affordance remain visible and aligned.
- Config can be opened and dismissed without hiding the active command path.
- Long model names and approval descriptions truncate cleanly without covering
  icons, chevrons, or adjacent labels.
- Background shell/task controls do not force runtime indicators or send actions
  onto a second row.
- The layout remains dense and operational, not modal-heavy or decorative.

### Risks

- Moving optional controls into a menu can reduce glanceability. Only collapse
  controls that are not needed for immediate message submission.
- A bottom sheet can feel heavier than a popover if used on desktop. Keep the
  sheet behavior mobile/container-width scoped.
- Container queries improve correctness but need careful fallback for older
  browsers.

## 7. Agent Kernel Debugger Mobile Layout

### Motivation

Agent Kernel Debugger is a dense diagnostic surface. It naturally contains
wide content: state diffs, JSON payloads, tool traces, request/response data,
timestamps, IDs, and tabular metadata. On mobile, these surfaces currently risk
overflowing to the right and making the page feel broken rather than merely
dense.

The debugger should remain useful on mobile, but it should not pretend that
every desktop column can stay visible at once. Mobile debugger views need an
explicit hierarchy, compact defaults, and contained overflow for truly wide raw
content.

### Design

State diff disclosure:

- State diff sections should default to hidden/collapsed, not expanded.
- A collapsed state diff row should still show a compact summary: changed path
  count, event/reducer label, and severity/status if available.
- Expanding state diff is a deliberate inspection action. It should not happen
  automatically on row selection or debugger tab entry.
- Expansion state should be dashboard-local. It must not be written into kernel
  state, shared protocol messages, or session logs.
- If expansion state is remembered, scope it to the current browser/profile and
  debugger surface. Do not treat it as runtime truth.

Mobile layout rules:

- No debugger surface should create page-level horizontal scrolling at 320-430
  px widths.
- Wide raw content may scroll inside its own bounded code/data container, but
  the surrounding page, tabs, headers, and action bars must stay within the
  viewport.
- Replace desktop multi-column rows with stacked key/value rows on mobile.
- Long IDs, paths, model names, request names, and file paths should use
  middle/end truncation with copy affordances where useful.
- Tabs and segmented controls should scroll or collapse within their own strip
  instead of forcing the full page wider.
- Code blocks, JSON viewers, and diff panes need `min-width: 0` containment at
  every flex/grid boundary so children cannot expand their ancestors.
- Sticky headers and toolbars should avoid fixed pixel widths on mobile.
- Dense metadata that is secondary on mobile should move behind disclosure or a
  details panel instead of wrapping into unreadable multi-line headers.

Diff and JSON rendering policy:

- Default to line wrapping for summaries and structured labels.
- Default to bounded horizontal scroll only for raw code, raw JSON, and diff
  hunks where preserving exact text layout matters.
- Keep copy/download actions visible outside the horizontally scrolling region.
- Avoid nested bordered cards around diffs; use a single bounded panel with a
  compact header and collapsible body.

### Implementation Plan

1. Audit debugger pages/components for page-level horizontal overflow at 320,
   375, 390, and 430 px widths.
2. Change state diff initial disclosure state to collapsed by default.
3. Add compact state diff summaries so the collapsed default still communicates
   whether a row matters.
4. Add `min-w-0`, responsive grid, and bounded overflow fixes at debugger panel
   boundaries rather than only on leaf code blocks.
5. Convert mobile metadata rows from desktop column layout to stacked key/value
   layout where needed.
6. Ensure tabs, toolbars, and action strips have their own contained overflow or
   collapse behavior.
7. Add regression tests or screenshots that assert no document-level horizontal
   overflow in the main debugger views.

### Acceptance Criteria

- State diff is hidden/collapsed by default on first open.
- Collapsed diff rows show enough summary to decide whether to expand.
- Opening a diff does not make the whole page horizontally scroll on mobile.
- At 320-430 px widths, debugger tabs, headers, payload panels, and toolbars do
  not overflow the viewport.
- Raw code/JSON/diff content may scroll inside bounded containers only.
- Copy/download actions remain reachable without horizontal scrolling.

### Risks

- Collapsing diffs can hide useful diagnostic detail if the summary is too weak.
  The summary needs enough changed-path and event context.
- Over-aggressive truncation can make IDs and paths hard to compare. Pair
  truncation with copy affordances on high-value identifiers.
- Fixing only leaf nodes will miss flex/grid ancestor overflow. The audit must
  include parent containers and page shells.

## 8. Settings Mobile Layout

### Problem Description

The current mobile settings view behaves like a desktop settings page squeezed
into a narrow viewport. The screenshot shows several concrete issues:

- The top tab bar tries to keep desktop tabs in one row. Labels and icons become
  crowded, and later tabs can be cut off or forced out of view.
- The page header, tab bar, and content body have desktop-scale spacing and
  borders, which makes the surface feel heavy on a phone.
- Section headings such as `Host endpoint` are too large for a compact form
  surface, reducing useful vertical space.
- Informational blocks such as `Currently used` consume too much height and do
  not distinguish primary value, source, and priority clearly enough.
- Long endpoint URLs and environment variable names are not given a mobile text
  strategy beyond ordinary wrapping/truncation.
- Primary, secondary, and destructive/reset actions are stacked without a clear
  mobile action hierarchy.
- The layout creates the impression of cards inside a framed page, which is too
  visually heavy for a dense dashboard settings surface.

### Design

Settings should use a mobile-specific form layout while preserving the existing
dense dashboard style.

Navigation:

- On mobile, settings tabs should use a contained horizontal tab strip with
  scroll affordance, or a compact section selector if the tab count grows.
- Tab buttons must have stable icon and label alignment. Labels may shorten, but
  icons and selected state must remain visible.
- The tab strip must not create page-level horizontal scrolling.
- The selected tab should remain discoverable after horizontal scrolling or
  section changes.

Header and section hierarchy:

- Reduce mobile heading scale. Settings page titles and section titles should
  use compact form-panel typography, not desktop hero-like sizes.
- Page description text should be shorter on mobile or constrained to fewer
  lines. Long explanatory copy belongs inside help text or disclosure.
- Section dividers should be lighter and spacing should be tighter than desktop.
- Avoid nested card impressions. Use simple sections, subtle dividers, and
  compact field groups instead of large framed blocks.

Information blocks:

- Important values, such as the currently used host endpoint, should be shown in
  a compact value row with copy affordance.
- Secondary details, such as source and priority order, should be smaller and may
  move behind `Details` disclosure on mobile.
- Long URLs, model IDs, environment variables, and token-like values should use
  a consistent truncation strategy with copy support.
- Inline code badges such as environment variable names must wrap or shrink
  without expanding the page width.

Form controls and actions:

- Inputs should remain full width, but labels, helper text, and validation
  messages must use compact spacing.
- Primary actions should be visually dominant. Secondary actions should be
  quieter. Reset/destructive actions should not look like another primary form
  step.
- Button groups may stack vertically on mobile, but the order must reflect task
  priority: save/apply first, test/validate second, reset/destructive last.
- Long button labels should not wrap into multiple lines unless there is no
  reasonable shorter label.

Mobile layout rules:

- Settings must not create page-level horizontal scroll at 320-430 px widths.
- Every settings tab should have an explicit mobile layout; do not fix only the
  connection tab.
- Form fields, tab strips, cards, and helper text need `min-width: 0` containment
  across flex/grid ancestors.
- Settings should remain readable in both standalone mobile browser and PWA
  display modes, including safe-area inset handling.

### Implementation Plan

1. Audit all settings tabs on 320, 375, 390, and 430 px widths.
2. Define shared mobile settings primitives: compact page header, tab strip or
   section selector, section heading, field group, info row, and action group.
3. Replace desktop-only tab assumptions with a contained mobile navigation
   pattern.
4. Reduce mobile typography and spacing for settings headers, section titles,
   helper text, and info blocks.
5. Normalize long-value handling for URLs, model IDs, env vars, and source
   labels with truncation plus copy affordances where useful.
6. Apply the action hierarchy consistently across connection, agent, models,
   hooks, Socket.IO Admin UI, cache, and future settings tabs.
7. Add visual regression coverage for every settings tab at mobile widths.

### Acceptance Criteria

- Settings tabs remain navigable and selected state is visible at 320 px width.
- No settings tab creates document-level horizontal overflow on mobile.
- Section headings and descriptions use compact mobile typography.
- Long host endpoints, env vars, model IDs, and provider names do not break the
  layout and remain copyable when important.
- Primary, secondary, and reset/destructive actions have clear visual hierarchy.
- The settings surface feels like a dense operational form, not a desktop card
  page compressed into a phone viewport.

### Risks

- A compact section selector can hide sibling tabs if overused. Prefer a
  horizontal strip while the tab count is still manageable.
- Reducing explanatory copy too aggressively can make risky settings unclear.
  Keep detailed help behind disclosure rather than deleting it.
- Shared primitives should not force every settings tab into identical content
  structure; they should only standardize mobile containment, typography, and
  action hierarchy.

## Verification Requirements

Every implementation PR from this plan should include:

- unit tests for feature detection and fallback behavior;
- tests for disabled settings where applicable;
- one unsupported-browser path per feature;
- no changes to kernel reducer state or shared wire protocol unless the PR
  explicitly introduces real runtime semantics;
- Playwright or Puppeteer coverage for visible dashboard UI changes;
- mobile viewport coverage for composer/config/footer changes, including
  screenshots or visual assertions for 320-430 px widths;
- mobile viewport coverage for Agent Kernel Debugger views, including an
  assertion that `document.documentElement.scrollWidth` does not exceed the
  viewport width for normal debugger navigation;
- coverage that state diff disclosure defaults to collapsed while still showing
  a compact summary;
- mobile viewport coverage for every settings tab, including tab navigation,
  long values, action groups, and no document-level horizontal overflow;
- a manual check that Socket.IO, host HTTP routes, and PWA update flows still
  work when the Service Worker is active.

For persistent session cache specifically:

- reload restores cached transcript before network history returns;
- host cursor behind cached cursor invalidates the local cache;
- host cursor ahead appends history from `sinceCursor`;
- session deletion clears L1 and L2 cache;
- workspace deletion clears all matching session cache entries;
- namespace mismatch ignores old cache;
- corrupted IndexedDB entries are dropped without breaking session load.

## Non-Goals

- No offline editing or queued offline user messages.
- No Service Worker interception of Socket.IO, host RPC, push routes, or session
  event streams.
- No protocol fields for browser-only cache, badge, save dialog, scheduler, or
  Wake Lock state.
- No automatic writes to the operator's local filesystem.
- No decorative motion or persistent status banners in high-frequency work
  surfaces.

## Suggested Order

1. Persistent session cache.
2. Background scheduling wrapper.
3. Mobile composer and compact control layout.
4. Agent Kernel Debugger mobile layout.
5. Settings mobile layout.
6. App badging.
7. File System Access save helper.
8. Wake Lock and page lifecycle handling.

The first two improve core dashboard performance and reliability. The mobile
composer work should happen early because it affects the primary message path.
The debugger mobile work should follow because it fixes a high-density surface
where layout overflow can block inspection. Settings mobile layout should be in
the same early UI pass because it affects configuration and recovery workflows.
The others are smaller progressive enhancements that can be implemented
independently.
