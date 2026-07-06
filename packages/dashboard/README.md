# @agent-kernel/dashboard

The **visualization layer**. A React SPA that subscribes to a Host session over Socket.IO and renders chat + a live state inspector + a replay/fork UI. Served by Host from `packages/dashboard/dist/`  -  no separate deploy required.

---

## Stack

- **Vite** + **React 18** + **TypeScript strict**
- **Tailwind CSS** with shadcn semantic tokens (`--background` / `--card` / `--sidebar` layered surfaces, light + dark themes via `darkMode: 'class'`)
- **Radix primitives** (`@radix-ui/react-dialog`) for modals and drawers
- **`lucide-react`** for icons
- **`date-fns`** for Today / Yesterday / Older session grouping
- **socket.io-client** for wire
- **Vitest** + **@testing-library/react** for component tests

Not Next.js (see [ADR 0008](../../docs/adr/0008-dashboard-vite-react.md)). This is a static SPA  -  no SSR, no server components. Ships as a `dist/` you can host anywhere (Cloudflare Pages, Vercel static, GitHub Pages, or the Host process serving `/`).

## Layout

Five-column Finder-style shell (see [ADR 0013](../../docs/adr/0013-dashboard-finder-layout.md)): Login (hidden)  -  Workspaces (daemons)  -  Agents  -  Sessions  -  Chat, with the Inspector as a right-side resizable drawer.

## Feature areas

- **Explorer** (`src/features/explorer/`)  -  workspace + session tree with time-bucket grouping, cwd surfacing, rename-in-place, Info dialogs for workspace and session metadata.
- **Chat panel** (`src/features/chat/`)  -  message list (text + image blocks, streaming render, compact boundary marker, user message edit + fork, image paste), Composer (model picker, context pressure ring, approval mode picker, `/compact` slash command, context pressure banner).
- **Inspector** (`src/features/inspector/`)
  - **State tree**  -  live JSON view of `AgentState`
  - **Timeline**  -  ordered event list with cursor labels; click an event to inspect it
  - **Effects**  -  per-event effect list (`call_llm`, `call_tool`, `persist`, `emit_progress`, `finish`)
  - **Usage**  -  running token totals
  - **Approvals**  -  cards with unified diff for `edit` / `write` tool calls
- **History** (`src/features/history/`)  -  timeline scrubber + Fork button on every event; lineage bar links back to the parent session.
- **Settings** (`src/features/settings/`)  -  provider list (auto-imported + user-added), model picker per provider, approval mode default, host / port config.
- **Create Session** (`src/features/create-session/`)  -  workspace picker + Finder-style cwd picker + provider/model picker.
- **Background terminal** (`src/features/background/`)  -  panel derived from `bash` / `bash_output` / `kill_shell` events.
- **Activity bar** (`src/features/activity/`)  -  bottom bar: runtime status, permission banners.

## What it does NOT do

- Call the LLM directly  -  always goes through Host.
- Persist sessions  -  Host owns the JSONL log; the dashboard is a viewer.
- Modify kernel state  -  every user action is a Socket.IO event dispatched to Host.

## References

- Wire protocol: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md)  - 3.2
- Architecture: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- **Visual style rules**: [`STYLE.md`](STYLE.md)  -  surface/border conventions, dark-mode do's-and-don'ts. **Read this before adding any `border-*` class.**

## Test coverage

Component tests use `@testing-library/react` with a mocked Socket.IO client, asserting user-visible behavior. Target per [`docs/testing.md`](../../docs/testing.md)  - 5.

**Caveat**: mocked-socket tests do **not** prove the app connects, renders, or accepts input against a real Host. For any UI-shipping change that touches the initial connection, first paint, or theming, verify against a real browser (headless is fine) hitting the Host-served bundle  -  see the "verify frontend with real browser" convention.
