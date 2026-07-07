# Dashboard UI Upgrades: 2026 Batch
  
  This document lists eight independent UI upgrades, ordered by expected value. Each item should be independently reversible. Structural changes are intentionally scheduled before visual polish so later work touches fewer mount points.
  
  ## Global Rules
  
  - Prefer copied single-file components in the shadcn style over broad package dependencies.
  - Every visual animation must respect `prefers-reduced-motion` and keep functionality intact without animation.
  - Each item must add or update tests using the existing Testing Library plus Vitest pattern.
  - Line numbers are only historical orientation; implementation should use nearby symbols and file anchors.
  
  ## 1. Virtualized Transcript with `react-virtuoso`
  
  Current `ChatPanel` and nested transcripts render every message. Long sessions with large diffs can cause scrolling and switching jank. Add `VirtualTranscript.tsx` to render only visible rows while preserving dynamic heights, pinned-to-bottom behavior, highlight jumps, footer slots, and nested transcript support.
  
  Acceptance tests should cover reduced DOM count for long transcripts, auto-follow for pinned mode, highlight scroll-to-index behavior, and nested transcript rendering.
  
  ## 2. Cmd/Ctrl+K Command Palette
  
  User actions are scattered across menus, composer controls, and slash commands. Add a global command registry and a `cmdk` palette grouped by Session, Workspace, Runtime, Composer, and View. Keep slash commands, but derive their entries from the same registry where practical. Restore focus after closing the palette.
  
  Tests should cover open/close, fuzzy search, command execution, disabled commands, lifecycle of register/unregister, and focus restoration.
  
  ## 3. Sonner Toast Notifications
  
  Keep persistent session errors in the existing banner, but use toasts for transient events: disconnect/reconnect, sub-agent completion/failure, background shell exit, and new approval requests. All call sites should go through a local `notify` wrapper rather than importing Sonner directly.
  
  Tests should mock notification calls and verify deduplication for replayed events.
  
  ## 4. Animated Border Beam
  
  Running sub-agent cards should have a subtle animated border beam to distinguish them from completed or failed cards. Implement this as a local CSS component with reduced-motion fallback. Do not add a heavy animation dependency for this effect.
  
  ## 5. Number Ticker
  
  Use a number ticker only for meaningful benchmark completion milestones, not for every table cell. It should make the final score arrival readable without interfering with result scanning.
  
  ## 6. Composer and Approval Surface Refinement
  
  The composer/approval flip should keep decision controls close to the input area and avoid stacking persistent banners. Multi-approval flows should use a single card with navigation and bulk actions.
  
  ## 7. Sub-Agent Matrix and Compact Activity
  
  Large bursts of tool or sub-agent activity should compress into readable grouped activity while preserving drill-down. The default view should emphasize status, counts, and the most recent actionable rows.
  
  ## 8. Final Polish Pass
  
  After structural changes land, do a focused pass over spacing, borders, reduced-motion behavior, mobile constraints, and text overflow. Do not introduce broad visual restyling during feature work.
  