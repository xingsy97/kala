# ADR 0012: Dashboard UI — session/executor management + layout + framework upgrade

**Status**: superseded by [ADR 0013](0013-dashboard-finder-layout.md)
**Date**: 2026-07-04

> **Note (2026-07-04)**: This ADR's diagnosis (missing session list, missing executor visibility, missing multi-Host awareness) is still accurate and its Alternatives-Considered section still reads correctly. Its *Decision* — an opencode-style rail with `@tanstack/react-router` + `@tanstack/react-query` + shadcn/ui — was reversed before implementation. ADR 0013 adopts Azure PR #879's Finder-style five-column layout instead (i.e., Alternative D below, reversed). Read this ADR for the analysis; read 0013 for what shipped.

## Context

The v1 Dashboard (shipped in Phase 4, extended in Phase 5) is a two-column React SPA:

```
┌────────────────────────────────────┬──────────────────┐
│  ConnectionBar (host / session id) │                  │
│  [LineageBar if forked]            │                  │
│  ChatPanel                         │  InspectorPanel  │
│  ApprovalsPanel                    │  (state / time-  │
│  [error strip]                     │   line / usage)  │
│  Composer                          │                  │
└────────────────────────────────────┴──────────────────┘
```

Whole app is `packages/dashboard/src/app.tsx` at ~180 LOC. Config (host URL, session id, token) is entered manually in a header input and mirrored to the URL query string. Fork navigates by mutating that `sessionId` state.

This was fine for the "prove replay/fork works" milestone. It is inadequate for anyone who actually uses the tool:

1. **No session management.** No way to list, switch between, name, or delete sessions. Every session must be opened by typing a session id — the same input field used to type into a chat. Fork produces a new id shown in the URL bar and nowhere else; if the user reloads without capturing it, the child session is orphaned in the JSONL directory.
2. **No executor / workspace management.** Each Host may have zero, one, or many Executors dialled in, each with its own workspace whitelist and tool set. The Dashboard exposes none of this. A user cannot see whether an executor is attached, which workspace it advertises, or which tools it will accept — so a session that fails with "no executor available" is indistinguishable from a session where the LLM decided not to call any tools.
3. **No multi-Host awareness.** The single `host` input assumes one Host at a time. A user running Host on a laptop and Host on Fly.io must edit the URL every time.
4. **Frontend is threadbare.** No router (`window.history.replaceState` only), no design system beyond raw Tailwind, no state library beyond React hooks. Adding session lists, executor drawers, and multi-Host panels on top of this is possible but the seams are already visible in the current 180-line file.

Two open-source projects already solved these problems in production and are worth reading before designing our own answer:

**opencode** (`references/opencode/packages/app/src/pages/`). SolidJS + Kobalte primitives + TanStack Solid Query + `@thisbeyond/solid-dnd`. Layout is a sidebar rail with **workspace → project → session** hierarchy:
- 280 px project column with server rows (with health-indicator dots), collapsible per-server project lists.
- Per-project hover card (`w-72`, `HoverCard placement="right-start" gutter={6}`) previews recent sessions without leaving the rail.
- Sessions grouped by today / yesterday / older via Luxon.
- Main area is the session page with composer + message timeline + side panel (file tree, review) + resize handles.

**Azure PR #879 code-agent-hub** (`sdk/webpubsub-chat-client/examples/code-agent-hub/web-portal/public/`). Vanilla ES-module JS + CSS, no framework. Layout is Finder-style **multi-column drill-down**:
```
[Login] → [Workspaces (daemons)] → [Agents] → [Sessions] → [Chat]
```
Each column has its own header, spinner, and action button. Sessions column adds a group-by bar (Name / Time / Agent). Chat column has a `session-ctx` header, message list, `session-toolbar` (model picker / mode picker / usage ring / working indicator), an async-work banner, and a composer with slash-menu + delegation chip + textarea. Cross-column actions live in modals: `create-session-modal` (2-column: Workspace+Tool | Agent+Directory), `daemon-access-drawer` (Member/Admin/Owner ACL). It is Azure-branded and depends on Web PubSub — we borrow the *layout*, not the transport.

Both designs solve the same problem — surface many sessions across many executors — with different visual metaphors: opencode's rail-plus-preview stays denser and closer to a code editor; Azure's column drill-down reads like the macOS Finder and makes hierarchical navigation explicit.

## Decision

Redesign the Dashboard in three layers.

### 1. Information architecture

Introduce three first-class UI concepts on top of what the wire protocol already carries:

| Concept | What it is | Where it comes from today |
|---|---|---|
| **Host connection** | A `{ url, token? }` the Dashboard has opened a Socket.IO session with. May be one or many. | Currently hard-coded to a single `host` URL param. |
| **Executor attachment** | An Executor that has dialled into a given Host, advertising `{ workspaces[], tools[], connected: bool }`. | Currently invisible in the UI. Wire protocol carries `executor:announce` — Host must relay executor presence to Dashboard subscribers. |
| **Session** | A JSONL log on a Host, addressable by `{ hostUrl, sessionId }`, with metadata `{ title?, createdAt, lastEventAt, parentSessionId?, eventCount, status }`. | Currently only the one the user typed in the connection bar. Host must expose a `session:list` control-plane event. |

### 2. Layout

Adopt **opencode's rail + expandable panel** as the outer chrome (denser, closer to the code-editor UX our users already live in) and **Azure's per-session toolbar + create-session modal** as the in-session controls (they concretely encode model / mode / usage / working state, which we already track in `AgentState` and have no UI for). Do not adopt Azure's Finder-style whole-app column drill-down: it duplicates state in five places and forces horizontal scrolling on smaller screens.

Concretely:

```
┌──┬─────────────────────┬────────────────────────────────────────────────┐
│  │ Hosts               │  ┌ Session toolbar ───────────────────────────┐│
│R │ ● laptop  (2 exec)  │  │ ● gpt-4o-mini · plan mode · $0.02 · idle   ││
│a │   ▸ ~/code/kernel   │  └────────────────────────────────────────────┘│
│i │   ▸ ~/code/scratch  │  ┌ ChatPanel (messages) ──────────────────────┐│
│l │ ● fly.io  (0 exec)  │  │ ...                                        ││
│  │                     │  │                                            ││
│H │ Sessions (12)       │  │                                            ││
│o │ ▸ Today             │  │                                            ││
│s │   • demo   idle     │  └────────────────────────────────────────────┘│
│t │   • wip-fork  ← fork│  ┌ Approvals ─────────────────────────────────┐│
│s │ ▸ Yesterday         │  │ [tool_call bash — Approve / Reject]        ││
│  │   • main            │  └────────────────────────────────────────────┘│
│I │                     │  ┌ Composer ──────────────────────────────────┐│
│n │ [+ New session]     │  │ > type here                                ││
│s │                     │  └────────────────────────────────────────────┘│
│  │                     │                                                │
│  │                     │  [Inspector as right drawer, resizable]        │
└──┴─────────────────────┴────────────────────────────────────────────────┘
   ↑ 40 px    ↑ 280 px       ↑ fills, min 720 px
```

- **Rail** (~40 px). Icon buttons: Hosts (default), Inspector (opens right drawer), Executors (opens drawer), Settings.
- **Hosts panel** (~280 px, collapsible). One row per Host with health dot, executor count, expandable list of workspaces per Host. Below Hosts: **Sessions** section grouped by *Today / Yesterday / Older* (Luxon-style), same pattern as opencode's home. Each session row: title (or first-user-message excerpt), status pill (`ready` / `working` / `error`), fork indicator if it has a parent. `+ New session` button at bottom opens the create-session modal.
- **Main panel**. Session toolbar (model / mode / cost-so-far / working indicator — data already tracked in `AgentState.usage` and `AgentConfig.model`), then the existing Chat + Approvals + Composer stack. Inspector moves to a **right-side resizable drawer** (default 400 px, dismissible), so it doesn't compete for chat width on smaller screens.
- **Modals** (Kobalte `Dialog`):
  - **Create session**: pick Host → pick workspace/executor → pick model → optional title → optional starter prompt.
  - **Add Host**: URL + optional token.
  - **Executor drawer**: per-Host list of attached executors, their advertised workspaces + tools, connected/disconnected, last-seen timestamp.
  - **Fork confirm**: shows source session + cursor + preview of state at that cursor before creating the child.

Empty states matter: "No Hosts yet — add one" and "No sessions yet — click + to create one" are what a first-run user sees.

### 3. Frontend stack

Stay on **React + Vite + TypeScript strict** (ADR 0008 still holds — no Next.js), but add the pieces that were missing:

| Concern | v1 (today) | v1.1 (this ADR) |
|---|---|---|
| Routing | `window.history.replaceState` only | `@tanstack/react-router` — file-based, type-safe, matches the `/hosts/:hostId/sessions/:sessionId` we now need |
| Server state | Ad-hoc `useEffect` + Socket.IO listeners | `@tanstack/react-query` for control-plane fetches (host list, executor list, session list). Live message stream stays on Socket.IO. |
| Primitives | Raw Tailwind + hand-rolled `<button>`s | **shadcn/ui** (Radix under the hood) for Dialog, DropdownMenu, Tooltip, ResizablePanel, ScrollArea, HoverCard, ContextMenu. shadcn is "copy the source into your repo" — no runtime dependency added, matches ADR 0001's spirit for the Dashboard. |
| Drag / reorder | none | `@dnd-kit/core` for session reorder within a group (kept optional; not blocking for v1.1) |
| Icons | none | `lucide-react` (single tree-shakeable dependency, matches shadcn's convention) |
| Dates / grouping | none | `date-fns` (lighter than Luxon; opencode chose Luxon, we don't need the timezone surface) |

The alternative frontend rewrites — SolidJS-a-la-opencode or vanilla-ES-modules-a-la-Azure — are covered in *Alternatives considered* below and rejected.

### 4. Wire protocol implications

The UI redesign requires two new control-plane surfaces on Host. These are *stated* here; the actual protocol change lands in a follow-up ADR + a `docs/protocol/wire-protocol.md` edit:

- `client:list_sessions` → `server:sessions` — enumerate JSONL logs in Host's session directory with metadata.
- `client:list_executors` → `server:executors` — return currently-attached executors with their announcements. Also fire `server:executor_changed` on attach/detach.

Both are additive; existing `client:hello` / `client:user_message` / `server:state` / `server:event` remain untouched. Dashboard degrades to today's behavior against a Host that doesn't implement them (missing panels stay empty with an "unsupported by host" note).

## Alternatives considered

**A. Ship the missing UI on the current React skeleton, no framework additions.**

*Rejected.* We can technically add session lists and executor drawers as more `useState` + `useEffect` in `app.tsx`. But: no router means no back button / no shareable URLs beyond query strings; no dialog primitive means either portal-manage-focus-trap by hand or accept the a11y regression; no query cache means every panel re-fetches on mount and races with live updates. All three problems compound as we add panels. The "add nothing" path is cheaper this week and more expensive every week after.

**B. Migrate to SolidJS + Kobalte + TanStack Solid Query + solid-dnd (i.e., opencode's stack).**

*Rejected — reluctantly.* Solid's fine-grained reactivity is a genuinely better fit for the state-tree and timeline inspector, both of which today re-render the whole tree on each event. Kobalte matches shadcn's Radix-derived API 1:1 in feel. And there's a ready-made template to crib from — opencode is MIT.

But: this is a full rewrite of ~300 LOC of React across `app.tsx`, `session.ts`, `ChatPanel`, `ApprovalsPanel`, `Composer`, `InspectorPanel`, plus the tests. The pool of contributors comfortable with SolidJS is much smaller than React (see ADR 0008's "optimization for accessibility over binary size"), and Solid's smaller ecosystem means we'd own more of the primitives ourselves. Correctness win doesn't justify the rewrite when TanStack Query + React 18's automatic batching plus `useSyncExternalStore` for the socket subscription close most of the perf gap. Keeping React also preserves ADR 0008's argument for the framework.

**C. Vanilla ES modules + custom state modules (i.e., Azure PR #879's stack).**

*Rejected.* Azure's `code-agent-hub` proves this can produce a working portal with ~zero build tooling. It also produces one giant `index.html` and a fleet of hand-rolled state modules (`portal-column-state`, `session-live-sync`, `create-session-state`, ...) that reinvent Query + Router + Dialog primitives in-house. For a project whose value proposition includes "readable and forkable" (ADR 0008), forcing every contributor to learn a bespoke state-module contract is worse than one they already know from job postings. Keep vanilla for the Azure demo; use a curated framework here.

**D. Adopt Azure's Finder-style five-column drill-down as the outer layout.**

*Rejected.* It's a visually striking pattern and encodes hierarchy well. But: (1) horizontal scroll is required on <1600 px displays because five columns × 240 px minimum = 1200 px + chat panel; (2) two of the five columns (Login, Agents) don't map to `agent-kernel`'s model — we authenticate at the Host connection level, and every session is one kernel + one model rather than a menu of "agents"; (3) users switching sessions in the same workspace must click through 3 columns each time. opencode's tree stays visible and clicks are one-hop.

**E. Do session/executor management outside the Dashboard (CLI-only).**

*Rejected.* Feasible — Host already writes JSONL and has a control socket. A CLI like `agent-kernel sessions ls` could do this. But session switching is a *high-frequency* action during replay/fork demos, which is where this project's differentiator lives. Making the marquee flow require a terminal round-trip is a demo-experience regression.

## Consequences

**Good**:
- First-run users can *see* what's happening: which Hosts exist, which executors have attached, which sessions have accumulated. Today, none of this is visible without `ls` on the JSONL directory + reading logs.
- Fork/replay finally has a home — sessions land in the sidebar with parent/child linkage visible, not as an ephemeral URL fragment.
- Session toolbar surfaces the `usage.costUsd` and `status` the kernel already tracks — no kernel change needed.
- Framework additions (TanStack Router / Query, shadcn primitives, lucide, date-fns) are all standard React-2026 vocabulary. No exotic contributor onboarding cost.
- Inspector moves to a drawer — chat width stops fighting the state tree for horizontal space on typical laptop displays.

**Bad**:
- `packages/dashboard/src/app.tsx` gets rewritten from ~180 LOC into a routed tree of components (`routes/hosts.tsx`, `routes/hosts.$hostId.sessions.$sessionId.tsx`, `components/HostsPanel.tsx`, `components/SessionRow.tsx`, `components/CreateSessionDialog.tsx`, `components/ExecutorDrawer.tsx`, ...). Estimated 1200–1600 LOC of dashboard code after landing; the current 7 tests grow to ~25.
- Two new wire-protocol events on Host (`client:list_sessions`, `client:list_executors`) plus a `server:executor_changed` broadcast. Additive, but needs implementation + docs + tests.
- Additional runtime dependencies on the dashboard side (`@tanstack/react-router`, `@tanstack/react-query`, `lucide-react`, `date-fns`, `@radix-ui/*` transitives via shadcn). Bundle grows — target stays under the 350 KB gzipped budget noted in ADR 0008's consequences.
- shadcn/ui is *copy-in*, not a dependency. Means we own the components' source under `packages/dashboard/src/components/ui/`. Upgrades require re-running the shadcn CLI or hand-patching. This is a deliberate shadcn trade-off — matches how the rest of the repo prefers explicit source over hidden magic.

**Deferred (not in this ADR)**:
- Dashboard **auth** beyond the current `?token=` query param. Multi-Host implies multi-token; whether that's a Host-issued JWT or a Dashboard-local keystore is out of scope here.
- **Real-time cursor / presence** (who else has this session open). Would use the same Socket.IO rooms Host already has; not v1.1.
- **Session search / full-text over messages.** Punted to a Post-v1 line in the ROADMAP.

## Verification

- `docs/adr/0000-index.md` lists this ADR.
- `packages/dashboard/README.md` reflects the redesign scope (in "Upcoming: v1.1 redesign" section) and does *not* claim Phase 4 is unimplemented (current README is stale — see [ADR 0011](0011-rename-host-and-core.md)-style sweep to be done as part of this ADR's follow-through).
- `docs/ROADMAP.md` Post-v1 section names this UI redesign as the next queued design work.
- No implementation lands under this ADR. Implementation lands in a follow-up PR gated on this ADR being accepted; that PR will add `@tanstack/react-router`, `@tanstack/react-query`, `lucide-react`, `date-fns` to `packages/dashboard/package.json`, and the new components/routes above.
