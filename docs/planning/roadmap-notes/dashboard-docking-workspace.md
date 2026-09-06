# Roadmap · Dashboard Docking Workspace

**Status**: Future todo; design direction proposed, unimplemented.
**Owner**: TBD
**Scope**: `@agent-kernel/dashboard` Agent workspace layout only.

---

## Problem

The Dashboard's Agent section is currently a fixed workbench composed in
`packages/dashboard/src/app.tsx`:

```text
AppShellNav
└── Agent section
    ├── Explorer left panel
    ├── Workbench toolbar
    ├── Chat transcript + Composer
    └── RightPanel tabs
        ├── Files
        ├── Git
        ├── Terminal
        └── Inspector
```

The current implementation uses `react-resizable-panels` for fixed split panes
and a custom `RightPanel` tab strip. This supports resizing and collapsing, but
it is not a real docking workspace: users cannot dock panels into arbitrary
regions, split horizontally or vertically on demand, merge panels into tabsets,
close and reopen panels from a registry, or persist a complete versioned layout
tree.

The root architectural issue is that `App` owns both layout state and business
state. It coordinates session selection, sockets, session projection, Composer
delivery, approvals, workspace state, dialogs, drawers, preferences, and panel
placement in one component. Adding a docking engine directly into `App` would
increase coupling instead of creating a stable workspace architecture.

## Non-goals

- Do not rewrite existing business components.
- Do not replace the session reducer, Socket.IO protocol, Host state model, or
  workspace/executor architecture.
- Do not store session state, transcripts, timeline entries, socket payloads, or
  workspace data inside the layout JSON.
- Do not introduce a generic draggable grid that lacks real docking, split, and
  tabset semantics.
- Do not force top-level pages such as Operations, Artifacts, Pipeline, Docs, or
  Memo into the first docking milestone.
- Do not enable arbitrary multi-instance panels until panel ownership semantics
  are explicitly designed.

## Recommended direction

Use `flexlayout-react` as the docking layout engine and wrap the existing
Dashboard modules as registered panels.

Rationale:

- It is a React-oriented docking layout manager, not a grid dashboard.
- It supports dockable tabsets, nested split rows/columns, resizing, and
  serializable layout models.
- It allows the layout engine to stay generic while panel rendering remains a
  Dashboard concern.
- It has lower implementation risk than self-building docking, drag previews,
  tabset management, resize handles, serialization, and migration.

Keep `react-resizable-panels` available for existing surfaces or small local
splitters, but do not use it as the foundation for a full docking workspace.

## Target architecture

Introduce a workspace boundary around the Agent section:

```text
AgentWorkspace
├── AgentWorkspaceProvider
│   ├── session/control socket state
│   ├── selected session and workspace context
│   ├── Composer and approval actions
│   └── shared panel services
├── WorkspaceLayoutProvider
│   ├── versioned layout loading
│   ├── migration
│   ├── persistence
│   └── reset-to-default
├── PanelRegistry
│   ├── chat
│   ├── explorer
│   ├── inspector
│   ├── files
│   ├── git
│   └── terminal
└── DockingWorkspace
    ├── layout engine
    └── panel renderer
```

The layout layer may know only layout facts:

```text
panel id
panel type
tabset
split orientation
relative size/weight
active tab
closed/open state
focused panel
```

Business facts remain outside the layout model:

```text
selected session
AgentState
timeline
pending approvals
queued messages
workspace id
cwd
socket connection
executor online state
model selection
```

## Panel registry

Add a typed registry so new panels do not require modifying the layout engine:

```ts
type AgentWorkspacePanelType =
  | 'chat'
  | 'explorer'
  | 'inspector'
  | 'files'
  | 'git'
  | 'terminal'

type PanelDefinition = {
  type: AgentWorkspacePanelType
  title: string
  component: React.ComponentType<PanelHostProps>
  singleton: boolean
}
```

Initial panels should be singleton:

- `chat`: wraps `ChatPanel` plus its existing Composer/footer/banner wiring.
- `explorer`: wraps `Explorer`.
- `inspector`: wraps `InspectorPanel`.
- `files`: wraps `SessionFilesPanel`.
- `git`: wraps `SourceControlPanel`.
- `terminal`: wraps `SessionTerminalPanel`.

Future work may allow multiple instances for selected panel types, such as
multiple terminal panels or file viewers, but only after panel-local identity,
persistence, and cleanup semantics are defined.

## Layout persistence

Persist only the docking model and UI layout metadata. Use local storage for the
first milestone, behind a small persistence adapter so a server-backed or
per-user layout store can be added later.

Suggested persisted envelope:

```ts
type PersistedAgentWorkspaceLayout = {
  version: 1
  workspaceId: 'agent-default'
  updatedAt: string
  layout: unknown
}
```

Rules:

- Validate persisted layout before loading it.
- Migrate older versions before rendering.
- Fall back to `DEFAULT_AGENT_WORKSPACE_LAYOUT` if validation or migration
  fails.
- `Reset Layout` removes the persisted layout and reloads the current default.
- Do not save a copy of the default layout as a permanent user layout unless the
  user has actually changed it.

## Default layout

The first default should preserve the current product shape:

```text
Explorer | Chat | Tool tabset
                  ├── Inspector
                  ├── Files
                  ├── Git
                  └── Terminal
```

This makes the migration behaviorally conservative while enabling later user
customization.

## Lifecycle constraints

Docking operations may mount, unmount, hide, reveal, or remount panels. Panel
lifecycle must not implicitly mutate business resources.

Required invariants:

- Moving, docking, or tabbing a panel must not create duplicate sockets.
- Moving, docking, or tabbing a panel must not duplicate workspace
  subscriptions or requests.
- Unmounting `SessionTerminalPanel` must not kill a PTY. Explicit Kill and
  session deletion remain the terminal destruction paths.
- `SessionTerminalPanel` must continue to use `ResizeObserver` or equivalent
  container-size observation after docking resize.
- File, Git, and Inspector panels should preserve useful local UI state across
  tab switches where feasible.
- Chat streaming and transcript virtualization must not be reset by unrelated
  layout changes.

## Performance constraints

The docking layer must not become a high-frequency render amplifier.

Required constraints:

- Session projection updates must not rerender every panel by changing one large
  context object each frame.
- Panel hosts should select only the state they need.
- Layout changes and business updates must be separate state channels.
- Dragging and resizing must not trigger network requests, session reloads, or
  expensive transcript recomputation.
- Large-session transcript and Inspector paths must retain virtualization and
  bounded history behavior.

## Migration plan

### Commit 1 — Extract AgentWorkspace boundary

- Move the current Agent-section layout from `App` into `AgentWorkspace`.
- Keep the visual layout and behavior unchanged.
- Pass current state/actions through a temporary prop object if necessary.
- Add tests proving the current Explorer, Chat, RightPanel, Composer, and mobile
  drawer behavior still renders.

### Commit 2 — Add Panel Registry and panel hosts

- Create `features/workspace/panels/panel-registry.tsx`.
- Add host wrappers for Chat, Explorer, Inspector, Files, Git, and Terminal.
- Keep the existing fixed `ResizablePanelGroup` layout.
- Ensure panel hosts do not own global session or socket state.

### Commit 3 — Add layout persistence primitives

- Add `DEFAULT_AGENT_WORKSPACE_LAYOUT`.
- Add schema validation, migration, load/save/reset helpers, and tests.
- Store layout through a small adapter rather than direct scattered
  `localStorage` calls.
- Add corrupted-layout fallback tests.

### Commit 4 — Introduce docking engine behind a feature flag

- Add `flexlayout-react`.
- Render the default layout through the docking engine.
- Keep the old fixed workbench available behind a fallback flag during initial
  rollout.
- Add tests for serialize/restore/reset and unknown panel fallback.

### Commit 5 — Enable user docking operations

- Enable drag/dock/split/tab/close/reopen operations for singleton panels.
- Add a visible panel reopen menu.
- Add real-browser tests for docking, tab merge, resize, close, reopen, reset,
  and refresh persistence.

### Commit 6 — Remove old fixed layout

- Remove obsolete `ak-outer-cols-*` and `ak-workbench-cols-*` fixed layout state
  after the docking layout has shipped and passed production observation.
- Keep migration/fallback logic for older persisted layouts.

## Acceptance criteria

- The Agent workspace can serialize and restore a complete layout tree.
- Users can reset to the current default layout.
- Invalid persisted layout cannot crash the Dashboard.
- Explorer, Chat, Inspector, Files, Git, and Terminal can be rendered by panel
  type through the registry.
- Docking layout changes do not alter selected session, socket ownership,
  queued messages, approvals, or workspace executor state.
- Terminal resize works after panel resize and panel movement.
- Terminal unmount/remount does not kill a running PTY.
- Large transcript rendering remains virtualized and responsive.
- The implementation passes targeted component tests, layout persistence tests,
  and real-browser docking tests.

