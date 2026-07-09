# ADR 0013: Dashboard Finder-style layout + control-plane events

**Status**: accepted
**Date**: 2026-07-04
**Supersedes**: [ADR 0012](0012-dashboard-ui-redesign.md)

## Context

[ADR 0012](0012-dashboard-ui-redesign.md) diagnosed the v1 Dashboard's real gaps — no session list, no executor visibility, no multi-Host awareness — and proposed an opencode-style rail + expandable panel with `@tanstack/react-router` + `@tanstack/react-query` + shadcn/ui.

That ADR never landed. When we tried to move on it, the user's actual mental model of the tool turned out to be closer to Azure Web PubSub's PR #879 (`code-agent-hub`) than to opencode's rail:

> translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical textcolumntranslated historical texttranslated historical textsession selector column，session cardtranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical textdaemontranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，iptranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical textdashboardtranslated historical texttranslated historical texttranslated historical texthost ip+porttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical textdaemontranslated historical texttranslated historical texttranslated historical text。

Two concrete requirements fell out of that:

1. **A daemon (== executor) selector exists as a first-class column.** The user should never type an IP:port into a text box to reach a machine. Executors announce themselves; the Dashboard shows them.
2. **Session cards must be attributed to a daemon** and expose OS, IP, and status so the user can pick the right machine before opening a session — not after.

A third gap surfaced independently: **timeline history is lost on refresh.** `useSession` (`packages/dashboard/src/session.ts`) only listens to `event:appended`; when the tab reloads, all previously-appended events vanish from the Inspector. Fixing this is scope-adjacent enough that we bundle it into this ADR — a Finder layout with an empty right column on every reload would be a regression.

Two open-source references informed the redesign:

- **opencode** (`references/opencode/packages/app/src/`) — SolidJS + Kobalte + TanStack Solid Query. Sidebar rail with workspace→project→session hierarchy, HoverCard preview, session groups by Today/Yesterday/Older. Denser but assumes the user already knows which workspace they want.
- **Azure PR #879 `code-agent-hub`** (`references/azure-code-agent-hub-pr879/web-portal/public/index.html`) — vanilla ES-modules. Finder-style five-column drill-down: Login → Workspaces (daemons) → Agents → Sessions → Chat. Each column has its own header, spinner, and action button. Chat column has a `session-toolbar` with model / mode / usage-ring / working indicator, plus a `create-session-modal`, a `daemon-access-drawer`, and a `delegation-chip`.

The Finder pattern makes the daemon step *explicit* — the user has to see and pick a machine before they see sessions, which is the ergonomic property the user is asking for. It also naturally accommodates an empty "Agents" column today (agent-kernel has exactly one agent — the kernel itself) that will fill in when we add subagents.

## Decision

Adopt Azure PR #879's **five-column Finder layout** as the Dashboard's outer chrome, retaining a small subset of ADR 0012's decisions (React + Vite + TS strict, shadcn primitives where they earn their keep, opencode's session-date-grouping) and reversing ADR 0012's rejection of the Finder pattern (Alternative D).

Daemon and Executor are the same thing at the wire-protocol level — an executor is the machine that runs shell tools; a daemon is what the user calls that machine. We do not add a new abstraction.

### 1. Layout — five columns, Finder-style

```
┌──────────┬────────────┬──────────┬───────────────┬──────────────────────────┐
│  Login   │ Workspaces │  Agents  │   Sessions    │          Chat            │
│ (hidden) │ (daemons)  │  (fixed) │               │                          │
├──────────┼────────────┼──────────┼───────────────┼──────────────────────────┤
│          │            │          │ Sort ▸ Name   │ ┌ Session toolbar ─────┐ │
│  [skele- │ ● laptop-01│ ○ kernel │  Time  Agent  │ │ gpt-4o · plan · $.02 │ │
│   ton    │   linux·   │          │ ─ Today ─     │ └──────────────────────┘ │
│   for    │   .1.42 ●  │          │  • demo idle  │ ┌ Chat messages ───────┐ │
│   OAuth] │ ○ fly-01   │          │  • wip-fork ⑂ │ │ ...                  │ │
│          │   linux·   │          │ ─ Yesterday ─ │ │                      │ │
│          │   fly.io ○ │          │  • main       │ └──────────────────────┘ │
│          │            │          │               │ ┌ Approvals ───────────┐ │
│          │            │          │               │ │ [tool_call bash]     │ │
│          │            │          │               │ └──────────────────────┘ │
│          │            │          │ [+ Session]   │ ┌ Composer ────────────┐ │
│          │            │          │               │ │ > type here          │ │
│          │            │          │               │ └──────────────────────┘ │
│          │            │          │               │  [Inspector drawer, ⇔]  │
└──────────┴────────────┴──────────┴───────────────┴──────────────────────────┘
  0 px       ~240 px      ~160 px    ~280 px         fills, min 720 px
```

Column-by-column:

- **Login** — `display: none` today. The DOM skeleton stays in place (a single `<div id="col-login">` empty container in the JSX tree) so future OAuth / local-login work has an obvious insertion point. Not a runtime-toggled feature flag; a comment marks it "future".
- **Workspaces (daemons)** — one row per attached executor. Row shows `{ hostname, os icon, ip, health dot }`. Health dot: green if `connected`, grey if last-seen within 30 s but socket closed, red otherwise. Row click selects the daemon and drives the downstream columns.
- **Agents** — for now, a single fixed row: `kernel`. This column exists so the Finder metaphor is intact, and so that when subagents / planner / memory land (ADR 0005) they have a home. It is not collapsed — collapsing it would break the drill-down cadence — but it is narrow.
- **Sessions** — sessions belonging to the selected daemon, grouped by *Today / Yesterday / Older*. Group header sort pills (Name / Time / Agent — Agent is a placeholder for the future). Each row: title (or first-user-message excerpt), status pill (idle / thinking / awaiting_approval / executing_tools / done / error, mapped from `AgentState.status`), fork indicator `⑂` if `parentSessionId` present, cost so far if > $0. "+ Session" button at the bottom opens Create Session Modal.
- **Chat** — the existing Chat + Approvals + Composer stack, unchanged in structure. Prepended by a **session toolbar** row (`{ model · mode · usage ring · working indicator }`). `usage` and `status` come from `AgentState`; `model` is not tracked in state today (see §5, Deferred). Inspector moves to a **right-side resizable drawer**, default 400 px, collapsible via a toolbar button.

Modals (Radix `Dialog` — no shadcn CLI needed for a single component):

- **Create Session Modal** — inline daemon picker (radio group over attached executors) + working-directory input + optional title. On submit, Dashboard opens a new `useSession` connection to that `sessionId` via the standard socket-io handshake (`{ sessionId, role: 'dashboard', token? }`); Host's `SessionStore.ensure()` writes the JSONL header if it doesn't exist yet. Model / mode pickers deferred until a model registry lands.
- **Daemon Details Drawer** — right drawer opened by clicking a daemon row's `⋯`; shows advertised tools, all IPs, uptime, runtime version, pid. No ACL yet (Azure had one; we don't have auth beyond `?token=`).

Empty states are load-bearing here: "No daemons attached — start an executor with `pnpm --filter @agent-kernel/executor start`" tells a first-run user exactly what to do next, and "No sessions on this daemon — click + Session" tells them the same for step 2.

### 2. Concept map — daemon and executor

The user's language: **daemon** = the machine running the shell. In `packages/executor/src/client.ts`, the entity that dials the Host is called an **Executor**. They are the same thing:

| User-facing term | Code term | Wire-protocol term |
|---|---|---|
| daemon | executor | `executor:announce` |

We do not rename the code. Dashboard UI uses "Workspaces" as the column header (Azure's word — it reads better than "Daemons" to non-sysadmins) and shows daemon-shape data (hostname / os / ip) in each row. Docs continue to say "executor" when referring to the code entity and "daemon" when referring to the user-visible machine, cross-linked in the glossary section of `docs/protocol/wire-protocol.md`.

### 3. Wire-protocol additions

Four new dashboard-facing events and one extended executor announce. All additive.

**`ExecutorAnnounce` — extended fields**

```ts
export type ExecutorAnnounce = {
  sessionId: string           // existing
  executorId: string          // existing
  tools: string[]             // existing
  workingDir?: string         // existing
  runtime: ExecutorRuntime    // existing
  runtimeVersion: string      // existing
  // new fields — all optional to preserve back-compat with older executors:
  hostname?: string           // os.hostname()
  os?: 'linux' | 'darwin' | 'win32' | 'other'  // normalized os.platform()
  ipAddresses?: string[]      // non-loopback, non-link-local IPv4/IPv6 addresses
  pid?: number                // process.pid
  startedAt?: string          // ISO-8601, executor process boot time
}
```

Every field is optional so an older executor connecting to a newer host still works; the Workspaces column shows whatever the executor advertises and falls back to `executorId` for the row label.

**Dashboard-side new events**

```ts
// list currently-attached executors on this host
export type ClientListExecutors = { /* no body */ }
export type ServerExecutorsPayload = {
  executors: ReadonlyArray<ExecutorAnnounce & { attachedAt: string }>
}

// broadcast whenever an executor attaches / detaches / re-announces
export type ServerExecutorChangedPayload = {
  executorId: string
  change: 'attached' | 'detached' | 'updated'
  executor?: ExecutorAnnounce & { attachedAt: string }  // omitted for 'detached'
}

// list sessions on this host, with a per-session daemon attribution
export type ClientListSessions = { /* no body */ }
export type ServerSessionsPayload = {
  sessions: ReadonlyArray<{
    sessionId: string
    createdAt: string          // from JSONL header
    lastEventAt?: string       // from last event line, if any
    eventCount: number
    parentSessionId?: string
    executorId?: string        // the executor that produced most of the events; nullable if unknown
    status?: AgentState['status']  // last known status from snapshot if present
    firstUserMessage?: string  // first ~120 chars of the first user_message text, for the row label
  }>
}

// on connect, fetch the full timeline so refresh doesn't lose events
export type ClientLoadHistory = {
  sessionId: string
  sinceCursor?: number   // if omitted, return the full log
}
export type ServerHistoryPayload = {
  sessionId: string
  entries: ReadonlyArray<EventAppendedEvent>  // same shape as live events
}
```

Socket.IO event names (dashboard namespace only):

```ts
// client → server
'client:list_executors'
'client:list_sessions'
'client:load_history'
// server → client
'server:executors'
'server:executor_changed'
'server:sessions'
'server:history'
```

**Fallback semantics.** A dashboard connecting to a host that predates these events gets no response; the panels stay in their empty state with an "unsupported by host" hint. A host receiving these from an old dashboard would never see them (old dashboards don't emit them).

`docs/protocol/wire-protocol.md` gains a new "Control-plane events" section covering all four, matched 1:1 to the types above. That edit lands in the same PR as the type additions.

### 4. Timeline history load

On dashboard connect (`useSession` mount), after `session:ready` lands:

1. Emit `client:load_history { sessionId }`.
2. Host reads `sessionsDir/<sessionId>.jsonl` via `readSessionLog()` (already exists in `packages/host/src/store/log.ts`).
3. Host maps event lines → `EventAppendedEvent[]` and returns them in `server:history`.
4. Dashboard merges the historical entries into `timeline` state before any subsequent `event:appended` starts appending. Merge is a straight append; dedup by `seq` in case a race delivers a live event that overlaps the tail of history.

This solves the refresh-loses-timeline bug the user called out. It also unlocks jumping into an old session (from the Sessions column) and immediately seeing what happened, not just what happens next.

### 5. Frontend stack — what we add and what we don't

Keep React + Vite + TypeScript strict (ADR 0008). We do **not** adopt ADR 0012's full framework menu.

| Concern | ADR 0012 proposed | ADR 0013 adopts |
|---|---|---|
| Routing | `@tanstack/react-router` | Plain URL query params, same as today. The Finder columns are stateful UI, not routes — a session change updates a search-param, not the pathname. Adding a router for one panel-selection state variable is overkill. |
| Server state | `@tanstack/react-query` | Ad-hoc `useEffect` + emit/on for the three new events. Query cache would be nice but the surface is small (three list endpoints); introducing Query for it isn't earning its bundle-size cost yet. Revisit when we add a fourth list. |
| Primitives | shadcn/ui (Dialog, Popover, etc.) | Radix `Dialog` directly for the Create Session modal + Daemon Details drawer, no shadcn scaffolding. If we end up wanting more (DropdownMenu, HoverCard, etc.) later we can pull them in one at a time. |
| Icons | `lucide-react` | `lucide-react` — kept. One icon set, tree-shakeable, small. |
| Dates | `date-fns` | `date-fns` — kept. Only for Today/Yesterday grouping. |
| Drag | `@dnd-kit/core` | dropped. Session reorder inside a group is not v1. |

Net dependency additions vs today: `@radix-ui/react-dialog`, `lucide-react`, `date-fns`. All three are single-purpose and small (~30 KB gzipped combined). Well under the 350 KB budget from ADR 0008.

### 6. Migration path

- ADR 0012 is superseded, not amended. Its Alternatives-Considered section still reads correctly — it captures a real analysis, and readers who wonder "did we consider opencode?" find the trade-off there. This ADR's Alternatives section restates why we reversed Alternative D.
- Existing `app.tsx` (~180 LOC, two-column) is rewritten into a `<FinderLayout>` shell with five column components. `ChatPanel`, `Composer`, `ApprovalsPanel`, `InspectorPanel` are reused verbatim; only their parent layout changes.
- `useSession` gains three new subscriptions (`server:executors` / `server:executor_changed` / `server:history`) and calls `client:load_history` on `session:ready`. The public shape (`{ status, state, timeline, ... }`) is a superset of today.
- The existing 4 dashboard fixes from this session (fork confirmation, assistant markdown, timeline direction+click, raw-state annotations) are preserved. They belong to `ChatPanel` and `InspectorPanel`, which are reused.

### 7. Test coverage

Component tests grow but stay in vitest + testing-library. The exact file names are the implementer's choice; what each test file covers:

- **Workspaces column** — renders one row per announced executor, health-dot color driven by attached/detached state, os-icon + ip + hostname visible, empty state text.
- **Sessions column** — group headers (Today/Yesterday/Older), sort pills, session-row status pill mapped from `AgentState.status`, fork indicator visibility when `parentSessionId` is set, empty state.
- **Create Session Modal** — daemon radio-group selection, submit opens a session (assert the socket handshake `auth.sessionId` matches the intended id), cancel closes the modal.
- **`useSession` history load** — emits `client:load_history` on `session:ready`, appends historical entries to `timeline` before any subsequent `event:appended`, dedups by `seq` when a live event overlaps the tail.
- **Preserved**: existing `ChatPanel.test.tsx` and `InspectorPanel.test.tsx` continue to pass unchanged.

E2E: an existing test opens the dashboard against a live host + executor. It gets one new assertion — after page reload, the timeline still shows the pre-reload events — plus assertions for daemon-row presence and session-row status pill.

## Alternatives considered

**A. Ship ADR 0012 as originally proposed (opencode-style rail + workspace/project hierarchy).**

*Rejected.* opencode's rail assumes the user already knows which workspace they want and is switching *inside* it. Our users are more often deciding *which machine to run against* — the daemon step is not incidental, it's the main navigational decision. Making it a rail hover-card demotes it. The Finder's explicit column for daemons matches how the user described their mental model. Additionally, TanStack Router + Query would be new tooling in the repo for state that fits comfortably in `useState`.

**B. Hybrid: opencode rail + a Daemons drawer.**

*Rejected.* Two entry points to the same information (rail row *and* drawer) doubles the surface area without adding clarity. The Finder pattern collapses the two into one: the daemon column *is* the drawer, always visible.

**C. Keep the two-column layout, add a "Sessions" pane above ChatPanel and a "Daemons" pane inside Inspector.**

*Rejected.* We tried a version of this mentally: it visibly makes ChatPanel narrower than users want. On a 1440-px display, chat gets ~700 px after subtracting Inspector (400) + Sessions (240) + Daemons (240); typography goes wrong below 640 px. The Finder layout keeps Chat at the far right where it dominates.

**D. Adopt Azure's full stack (vanilla ES modules, no framework).**

*Rejected*, same reason ADR 0012 rejected it: forcing every contributor to learn hand-rolled state modules is a higher tax than sticking with React. We borrow the *layout* and the *interaction model* (columns as drill-down, session-toolbar as in-session controls); we do not borrow the transport or state management.

**E. Manage sessions / daemons via CLI only, keep the Dashboard chat-focused.**

*Rejected*, same reason ADR 0012 rejected it: switching sessions is high-frequency in replay/fork demos, which are the product's differentiator. A terminal round-trip in the marquee flow is a regression.

## Consequences

**Good**:

- Daemon selection stops being an IP+port text box. First-run users see attached machines and click to pick.
- Session cards attribute themselves to a daemon and expose OS / IP / status — the metadata the user asked for is visible before opening the session, not after.
- Timeline persists across refresh. The Inspector stops being a "since this reload" view and becomes a "since session start" view.
- Sub-agents / planner (ADR 0005 deferred surface) have a home when they land — the Agents column is intentionally kept even though it holds only one row today.
- No new router, no new query cache. The dashboard stays small enough that a new contributor can read the whole `app.tsx` in one sitting.
- ADR 0008's bundle-size argument continues to hold: `date-fns` + `lucide-react` + `@radix-ui/react-dialog` are the only additions.

**Bad**:

- Five columns don't fit comfortably below ~1200 px. We add a `≤ 900 px` collapse rule: Workspaces and Agents fold behind a hamburger, only the currently-selected daemon + agent appears as breadcrumbs above the Sessions column. The full-width behavior is what the user actually asked for; the narrow-screen fallback is not "the same experience" but is at least usable.
- `ExecutorAnnounce` grows five fields. Older executors omit them; the Workspaces column falls back to `executorId`. Not a break, but a "why is this row missing an OS icon?" cognitive step for the reader.
- `readSessionLog` runs on every dashboard connect. `readFile`+`JSON.parse` per line; for a session with thousands of events, that's a few ms and one syscall. Mitigation if it ever shows as a hotspot: `client:load_history` accepts `sinceCursor` so returning-visitor dashboards fetch only the tail, and the response can be chunked over multiple `server:history` frames.
- ADR 0012's proposed framework additions (TanStack Router / Query, shadcn CLI, dnd-kit) are *not* landing. That was scaffolding for a design we're not shipping.

**Deferred**:

- Multi-Host awareness. Today the Dashboard talks to exactly one Host (config's `host` URL). Adding a Hosts column outside the Workspaces column is possible but out of scope here — most users will run one Host locally.
- Session search / full-text over messages — punted to Post-v1.
- Model / mode picker in the session toolbar. `AgentConfig` doesn't carry a model field today, and there's no model registry to enumerate. The toolbar shows a static "model: —" label until that lands.
- Real-time cursor / presence, cross-agent-call delegation-chip, session ACLs — Azure-PR-borrowed UI elements we do *not* replicate in v1.

## Verification

- `docs/adr/0000-index.md` lists this ADR as `accepted` and marks ADR 0012 as `superseded by 0013`.
- `docs/protocol/wire-protocol.md` gains a "Control-plane events" section (`client:list_executors`, `client:list_sessions`, `client:load_history`, and their responses / broadcasts), plus the extended `ExecutorAnnounce` fields. Reviewer opens both this ADR and the wire-protocol doc side by side and confirms every event shape matches.
- `packages/dashboard/README.md` reflects the Finder layout in its screenshot / architecture section (README already stale per ADR 0011 — this ADR does not fix the whole README, but it does not further stale it).
- Implementation lands in a follow-up PR (tracked as tasks #59 / #60 / #61 / #63 in the active task list) and includes: extended `ExecutorAnnounce` in `packages/shared/src/protocol.ts`, executor announce emitting the new fields in `packages/executor/src/client.ts`, new events wired in `packages/host/src/server.ts`, and the five-column layout in `packages/dashboard/src/`. Tests per §7. Real-browser DOM check per the standing feedback that mocked component tests aren't proof a UI works — open a headless browser and observe the DOM before reporting the follow-up PR done.
