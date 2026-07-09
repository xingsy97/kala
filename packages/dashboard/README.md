# @agent-kernel/dashboard

The **visualization layer**. A React SPA that subscribes to a Host session over Socket.IO and renders chat + a live state inspector + a replay/fork UI.

**Status**: Phase 4 shipped (chat + inspector), Phase 5 shipped (replay + fork + lineage UI). 7 dashboard tests, integrates end-to-end with Host + Executor. See [ROADMAP](../../docs/ROADMAP.md).

**Upcoming — v1.1 redesign** ([ADR 0012](../../docs/adr/0012-dashboard-ui-redesign.md), proposed): the current two-column layout does not surface session management or executor/workspace management. The redesign introduces a Hosts / Sessions sidebar rail, a per-session toolbar (model / mode / usage / working indicator), and modal-based create-session + executor drawer flows. Framework additions: `@tanstack/react-router`, `@tanstack/react-query`, shadcn/ui primitives, `lucide-react`, `date-fns`. Not implemented yet — read the ADR first.

---

## Stack

**Today (v1)**:
- **Vite** + **React 18** + **TypeScript strict**
- **Tailwind CSS** (raw utilities, no design-system primitives yet)
- **socket.io-client** for wire
- **Vitest** + **@testing-library/react** for component tests

**Planned for v1.1** ([ADR 0012](../../docs/adr/0012-dashboard-ui-redesign.md)):
- **`@tanstack/react-router`** — file-based, type-safe routes for `/hosts/:hostId/sessions/:sessionId`
- **`@tanstack/react-query`** — cache for control-plane fetches (host list, executor list, session list); live message stream stays on Socket.IO
- **shadcn/ui** (Radix under the hood, copy-in components) for Dialog / DropdownMenu / Tooltip / ResizablePanel / ScrollArea / HoverCard / ContextMenu
- **`lucide-react`** for icons
- **`date-fns`** for session grouping (today / yesterday / older)
- **Playwright** for e2e (not yet wired)

Not Next.js ([ADR 0008](../../docs/adr/0008-dashboard-vite-react.md)). This is a static SPA — no SSR, no server components. Ships as a `dist/` you can host anywhere (Cloudflare Pages, Vercel static, GitHub Pages, or the Host process serving `/`).

## Feature areas

**Shipped in v1**:
- **Chat panel** (`src/features/chat/`) — message list, input, approval cards for tool calls awaiting user confirmation
- **Inspector panel** (`src/features/inspector/`)
  - **State tree** — live JSON view of `AgentState`
  - **Timeline** — ordered event list with cursor labels; click an event to inspect it
  - **Effects** — per-event effect list (`call_llm`, `call_tool`, `persist`, `emit_progress`, `finish`)
  - **Usage** — running token/cost totals
- **Replay/fork UI** — timeline scrubber + fork button on every event; lineage bar links back to the parent session
- **Connection bar** — host URL + session id + status pill (single Host at a time)

**Planned for v1.1** ([ADR 0012](../../docs/adr/0012-dashboard-ui-redesign.md)):
- **Hosts panel** — multi-Host sidebar with health dots, executor counts, expandable workspace lists per Host
- **Sessions panel** — grouped (today / yesterday / older), status pills, fork indicators, `+ New session` button
- **Session toolbar** — model / mode / running cost / working indicator, per session
- **Create-session modal** — pick Host → workspace → model → title → optional starter prompt
- **Executor drawer** — per-Host list of attached executors with advertised workspaces + tools + connection state
- **Inspector as right-side resizable drawer** — dismissible, so chat width stops fighting the state tree
- **Diff view** for `write` / `edit` approvals (renders unified diff before user approves)

**Deferred / never**:
- **WebContainer executor** — Phase 6 declined; kernel/protocol stay agnostic to executor location
- **Real-time cursor / presence** — post-v1.1
- **Full-text session search** — post-v1.1

## What it does NOT do

- Call the LLM directly — always goes through Host.
- Persist sessions — Host owns the JSONL log; the dashboard is a viewer.
- Modify kernel state — every user action is a Socket.IO event dispatched to Host.

## References

- Wire protocol: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md) §3.2
- Architecture: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- How to build this package: [`docs/implementation-guide.md`](../../docs/implementation-guide.md) §5

## Test coverage target

Today: 7 component tests covering ChatPanel / ApprovalsPanel / Composer / InspectorPanel / LineageBar / session hook / app connection flow. Uses `@testing-library/react` with a mocked Socket.IO client.

**Caveat**: mocked-socket tests do **not** prove the app connects, renders, or accepts input against a real Host. For any UI-shipping change that touches the initial connection or first paint, verify against a real browser (headless is fine) hitting the dev server — see the "verify frontend with real browser" convention in the memory notes.

v1.1 target (per [`docs/testing.md`](../../docs/testing.md) §5): 60% component + 40% e2e. Component tests continue with `@testing-library/react` and assert user-visible behavior. E2e (Playwright, not yet wired) runs the full stack (Host + Executor + Dashboard) against a mock LLM adapter to avoid burning real API tokens.
