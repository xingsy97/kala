# Dashboard UI upgrades — 2026 batch

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text UI translated historical texttranslated historical text,translated historical text**translated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text mount translated historical texttranslated historical text)translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text —— translated historical texttranslated historical texttranslated historical text PR translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

translated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical text**:translated historical texttranslated historical texttranslated historical texttranslated historical text "translated historical texttranslated historical text" translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text PR translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## translated historical texttranslated historical texttranslated historical texttranslated historical text

- **translated historical texttranslated historical texttranslated historical texttranslated historical text**:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(shadcn translated historical texttranslated historical texttranslated historical texttranslated historical text),translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- **translated historical texttranslated historical text**:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `prefers-reduced-motion`,translated historical text wow-factor translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- **translated historical texttranslated historical text**:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical text。ChatPanel/Composer/SubAgentCard translated historical texttranslated historical text test translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `@testing-library/react + vitest` translated historical texttranslated historical text。
- **translated historical texttranslated historical texttranslated historical texttranslated historical text**:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical text HEAD**(2026-07-07)translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text PR translated historical texttranslated historical texttranslated historical texttranslated historical text+translated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text/translated historical texttranslated historical text)translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- **translated historical texttranslated historical text**:1 → 3 → 2 → 6 → 4 → 5 → 7 → 8。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text "translated historical texttranslated historical text" translated historical text。

---

## #1 translated historical texttranslated historical texttranslated historical text transcript(`react-virtuoso`)

### translated historical texttranslated historical text
- `packages/dashboard/src/features/chat/ChatPanel.tsx` translated historical text `ChatPanel` translated historical texttranslated historical text `transcriptItems.map(...)`(translated historical text line 146-169)。
- translated historical texttranslated historical text assistant translated historical texttranslated historical texttranslated historical text DOM,ScrollArea viewport translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical text(>200 translated historical texttranslated historical texttranslated historical text + translated historical text diff)translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical text。
- Auto-follow translated historical texttranslated historical texttranslated historical text `app.tsx` translated historical text `pinnedToBottomRef`(translated historical text line 455-483),translated historical texttranslated historical text `[data-radix-scroll-area-viewport]` translated historical texttranslated historical texttranslated historical texttranslated historical text `scrollTop = scrollHeight`。
- Highlight-jump translated historical text `app.tsx` line 890-896:`document.getElementById('msg-${index}')` + `scrollIntoView`。
- `NestedTranscript`(SubAgentCard translated historical texttranslated historical text)translated historical texttranslated historical texttranslated historical text `.map()`,translated historical texttranslated historical text `ScrollArea` translated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text `h-56` / `h-[28rem]`。

### translated historical texttranslated historical text
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,DOM translated historical texttranslated historical text viewport translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:translated historical texttranslated historical text vs translated historical texttranslated historical texttranslated historical text diff)。
- Auto-follow translated historical texttranslated historical texttranslated historical texttranslated historical text:pinned translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,unpinned translated historical texttranslated historical texttranslated historical text。
- Highlight-jump translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text index。
- Nested transcript translated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical text `packages/dashboard/src/features/chat/VirtualTranscript.tsx`,translated historical texttranslated historical text:

```tsx
type Props = {
  items: readonly TranscriptItem[]
  renderItem: (item: TranscriptItem, index: number) => JSX.Element
  pinnedToBottom: boolean            // translated historical texttranslated historical text ref-owner translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text pin translated historical texttranslated historical text
  onPinnedChange: (pinned: boolean) => void  // translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text pin translated historical texttranslated historical texttranslated historical text
  highlightIndex?: number | null     // translated historical texttranslated historical texttranslated historical text scrollToIndex + translated historical texttranslated historical text
  footerSlot?: JSX.Element | null
}
```

`ChatPanel` translated historical texttranslated historical texttranslated historical texttranslated historical text API translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `.map()` translated historical texttranslated historical text `<VirtualTranscript items renderItem={...}>`。translated historical texttranslated historical text `app.tsx` translated historical texttranslated historical texttranslated historical texttranslated historical text `pinnedToBottomRef` + `viewport.scrollTop = scrollHeight` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text VirtualTranscript(translated historical text virtuoso translated historical text `atBottomStateChange` + `followOutput`),`app.tsx` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

`NestedTranscript` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(SubAgentCard translated historical texttranslated historical texttranslated historical text `h-56`/`h-[28rem]`),virtuoso translated historical texttranslated historical texttranslated historical text fit。

### translated historical texttranslated historical texttranslated historical texttranslated historical text
- `pnpm add react-virtuoso`(translated historical texttranslated historical texttranslated historical texttranslated historical text `react` 18,~30KB min+gz)。
- `Virtuoso` translated historical text `followOutput: 'smooth'` translated historical texttranslated historical texttranslated historical texttranslated historical text "pinned translated historical texttranslated historical texttranslated historical texttranslated historical text,unpinned translated historical texttranslated historical texttranslated historical texttranslated historical text" translated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical text `atBottomStateChange` translated historical texttranslated historical texttranslated historical text pin translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text 64px translated historical texttranslated historical texttranslated historical texttranslated historical text(virtuoso translated historical texttranslated historical texttranslated historical texttranslated historical text)。
- Highlight-jump translated historical text `virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })`。
- translated historical texttranslated historical text `id={msg-${index}}` translated historical texttranslated historical text(Inspector translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text),translated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical text。
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**:virtuoso translated historical text `useResizeObserver` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。markdown streaming translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `AssistantMarkdown` translated historical text `React.memo` translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical texttranslated historical text `VirtualTranscript.test.tsx`:
  - 100 translated historical texttranslated historical texttranslated historical texttranslated historical text DOM translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `MessageRow` translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text `[data-testid^="message-"]`)。
  - `pinnedToBottom=true` + translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(mock `scrollToIndex` translated historical texttranslated historical texttranslated historical text virtuoso translated historical text `atBottom` translated historical texttranslated historical text)。
  - `highlightIndex` translated historical texttranslated historical text → translated historical texttranslated historical text `scrollToIndex`。
- translated historical texttranslated historical text `ChatPanel.test.tsx`:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(items rendered、compact boundary、footerSlot translated historical texttranslated historical text)。
- translated historical texttranslated historical text `SubAgentCard.test.tsx`:nested transcript translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- Virtuoso translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical text:translated historical texttranslated historical texttranslated historical text item translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `defaultItemHeight`。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text jsdom,virtuoso translated historical texttranslated historical text `ResizeObserver`。translated historical texttranslated historical texttranslated historical text `vitest.setup.ts` translated historical text polyfill(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。

### translated historical texttranslated historical text:translated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text ChatPanel。translated historical texttranslated historical text list translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical text renderItem translated historical text**translated historical texttranslated historical texttranslated historical text/translated historical texttranslated historical text/toast translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## #2 Cmd+K translated historical texttranslated historical texttranslated historical texttranslated historical text(`cmdk`)

### translated historical texttranslated historical text
- translated historical texttranslated historical text action translated historical texttranslated historical texttranslated historical texttranslated historical text:
  - `selectSession` / `newSession` / `deleteSessionAt` / `renameSessionAt` translated historical text `app.tsx` translated historical text sidebar translated historical texttranslated historical text。
  - `openCwdDialog` / `submitCwd` translated historical text header translated historical texttranslated historical text。
  - `setSessionModel` / `setSessionApprovalMode` translated historical text Composer translated historical texttranslated historical text Select。
  - `runCompactNow` / `runConsolidateMemory` / `toggleTheme` translated historical texttranslated historical texttranslated historical text header translated historical text slash command。
- Slash command translated historical texttranslated historical text Composer translated historical texttranslated historical texttranslated historical texttranslated historical text `/` translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical text Composer.tsx line 119-163),translated historical texttranslated historical texttranslated historical texttranslated historical text 4 translated historical text(`/compact`, `/cancel`, `/clear`, `/consolidate-memory`)。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:translated historical texttranslated historical text Composer translated historical texttranslated historical texttranslated historical text arrow/enter/tab/esc(mention/slash),ApprovalCard translated historical texttranslated historical texttranslated historical text enter/esc/arrow(carousel)。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- Cmd/Ctrl+K translated historical texttranslated historical texttranslated historical texttranslated historical text palette。
- Fuzzy translated historical texttranslated historical texttranslated historical texttranslated historical text action。
- translated historical texttranslated historical texttranslated historical texttranslated historical text(Session / Workspace / Runtime / Composer)。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text focus:translated historical texttranslated historical texttranslated historical text focus translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical text slash command translated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text),translated historical text palette translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text action —— translated historical texttranslated historical text registry。

### translated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:

1. `packages/dashboard/src/commands/registry.ts`:
```ts
export type Command = {
  id: string                    // translated historical texttranslated historical text ID,translated historical text:'session.new'
  group: 'Session' | 'Workspace' | 'Runtime' | 'Composer' | 'View'
  label: string
  hint?: string                 // translated historical texttranslated historical texttranslated historical text
  icon?: LucideIcon
  keywords?: readonly string[]  // translated historical texttranslated historical text fuzzy translated historical texttranslated historical texttranslated historical text
  shortcut?: readonly string[]  // translated historical texttranslated historical texttranslated historical text,translated historical text:['⌘', 'K']
  run: () => void | Promise<void>
  when?: () => boolean          // translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text true
}

export type CommandRegistry = {
  register: (cmd: Command) => () => void  // translated historical texttranslated historical text unregister
  list: () => readonly Command[]
}
```

2. `packages/dashboard/src/features/palette/CommandPalette.tsx`:
```tsx
type Props = { registry: CommandRegistry }
// translated historical texttranslated historical text:translated historical texttranslated historical text keydown listener(Cmd/Ctrl+K),cmdk Dialog + CommandList + CommandGroup
```

`app.tsx` translated historical texttranslated historical texttranslated historical texttranslated historical text registry,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text action translated historical texttranslated historical texttranslated historical texttranslated historical text。Composer translated historical text slash command list translated historical texttranslated historical texttranslated historical text registry translated historical texttranslated historical text(translated historical texttranslated historical text `group === 'Composer' || when()`),translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical texttranslated historical texttranslated historical text
- `pnpm add cmdk`(translated historical texttranslated historical texttranslated historical text shadcn translated historical texttranslated historical texttranslated historical texttranslated historical text,~6KB)。
- translated historical texttranslated historical text listener translated historical texttranslated historical text `document`,mount translated historical text `addEventListener('keydown')`。**translated historical texttranslated historical text** input/textarea translated historical texttranslated historical texttranslated historical text Cmd+K(translated historical text `e.target.tagName` translated historical texttranslated historical text)。
- translated historical texttranslated historical text `document.activeElement` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `focus()` translated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text Mac vs translated historical texttranslated historical text:`navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'`。
- Palette translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text `cmd.run()`。

### translated historical texttranslated historical text
- translated historical texttranslated historical text `CommandPalette.test.tsx`:
  - translated historical text Cmd+K translated historical texttranslated historical text、Esc translated historical texttranslated historical text。
  - translated historical texttranslated historical text "new" → translated historical texttranslated historical text label/keywords translated historical texttranslated historical texttranslated historical text command translated historical texttranslated historical text。
  - Enter translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text → `run` translated historical texttranslated historical texttranslated historical text。
  - translated historical texttranslated historical texttranslated historical text focus translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical text `registry.test.ts`:register/unregister translated historical texttranslated historical texttranslated historical texttranslated historical text,`when()` translated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical texttranslated historical text listener translated historical texttranslated historical text:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text Cmd+K translated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text —— translated historical texttranslated historical texttranslated historical texttranslated historical text `!input && !textarea` translated historical texttranslated historical texttranslated historical text)。
- Composer translated historical text slash list UI translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `matchingCommands` state,translated historical texttranslated historical texttranslated historical text registry-driven translated historical texttranslated historical texttranslated historical texttranslated historical text UI translated historical texttranslated historical text。

### translated historical texttranslated historical text:translated historical text #1 translated historical texttranslated historical text
palette translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text "translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text #X",translated historical texttranslated historical texttranslated historical text VirtualTranscript translated historical text `scrollToIndex` API。

---

## #3 Sonner toast translated historical texttranslated historical text

### translated historical texttranslated historical text
- translated historical texttranslated historical text UI translated historical texttranslated historical text `app.tsx` line 758-773 translated historical texttranslated historical texttranslated historical text banner + `ErrorBoundary` translated historical texttranslated historical text。
- Socket translated historical texttranslated historical text(connect_error / disconnect,session.ts line 256-260)translated historical text setState `status`,UI translated historical texttranslated historical texttranslated historical text header translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- Sub-agent translated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text —— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- Background shell exit translated historical texttranslated historical texttranslated historical texttranslated historical text。
- Approval translated historical texttranslated historical texttranslated historical texttranslated historical text Composer translated historical texttranslated historical texttranslated historical text flip translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text composer translated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical texttranslated historical text sonner,translated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text banner translated historical texttranslated historical text(translated historical texttranslated historical text"session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"),toast translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical text**。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:
  - Socket disconnect / reconnect
  - Sub-agent translated historical texttranslated historical text(translated historical texttranslated historical text/translated historical texttranslated historical text,shows agent_type + duration)
  - Background shell exit(shows command head + exit status)
  - Approval required(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text "Review")

### translated historical texttranslated historical text
translated historical texttranslated historical text `packages/dashboard/src/notify.ts`:
```ts
export type NotifyKind = 'info' | 'success' | 'warning' | 'error'

export const notify = {
  info: (msg: string, opts?: NotifyOpts) => void,
  success: (msg: string, opts?: NotifyOpts) => void,
  warning: (msg: string, opts?: NotifyOpts) => void,
  error: (msg: string, opts?: NotifyOpts) => void,
}

type NotifyOpts = {
  description?: string
  action?: { label: string; onClick: () => void }
  duration?: number  // ms, undefined = default (4s), Infinity = translated historical texttranslated historical texttranslated historical text
  id?: string        // dedupe key
}
```

translated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical text `notify.*`**,translated historical texttranslated historical texttranslated historical text import sonner。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

`app.tsx` translated historical texttranslated historical text `<Toaster position="bottom-right" richColors />`(sonner translated historical text shadcn translated historical texttranslated historical texttranslated historical text `bottom-right`)。

### translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text)
- `session.ts` socket handlers:
  - `on('connect')` translated historical texttranslated historical texttranslated historical text `status === 'disconnected'` → `notify.success('Reconnected')`。
  - `on('disconnect')` → `notify.warning('Disconnected — trying to reconnect')`。
- `session.ts` translated historical texttranslated historical text hook `useSubAgentNotifier`:translated historical texttranslated historical text `server:sub_agent_completed` / `server:sub_agent_failed` → `notify.success` / `notify.error`,description translated historical text agent_type + duration。
- `background-terminal.ts`:translated historical texttranslated historical texttranslated historical text `done` / `killed` translated historical text → `notify.info('Shell finished: ' + splitCommand(cmd).head)`,action `{ label: 'View', onClick: () => openBackgroundShellsPanel() }`。
- `session.ts` approval:`state.pendingCalls` translated historical text 0 translated historical texttranslated historical texttranslated historical text → `notify.info('Approval requested')`,action `{ label: 'Review', onClick: () => focusApprovalCard() }`。

### translated historical texttranslated historical text
- translated historical texttranslated historical text `notify.test.ts`:mock sonner,translated historical texttranslated historical text `notify.error(...)` translated historical texttranslated historical text `sonner.error` translated historical text opts translated historical texttranslated historical text。
- translated historical texttranslated historical text `useSubAgentNotifier.test.tsx`:translated historical texttranslated historical texttranslated historical text `sub_agent_completed` translated historical texttranslated historical text → notify.success translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- Reconnect notification:mock socket translated historical texttranslated historical text disconnect → connect,translated historical texttranslated historical text notify.warning + notify.success translated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- Dedup:translated historical text session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `id` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical text approval banner translated historical texttranslated historical text:banner translated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text",toast translated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text",translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text pending translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical text(translated historical text `id: 'approval-${callId}'` dedupe)。

### translated historical texttranslated historical text:translated historical text #1 translated historical texttranslated historical texttranslated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical text #2 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical text #2 translated historical texttranslated historical text palette translated historical texttranslated historical texttranslated historical texttranslated historical text `notify` translated historical text hint,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## #4 Animated Beam translated historical texttranslated historical text

### translated historical texttranslated historical text
- `SubAgentCard.tsx` line 173-183 translated historical texttranslated historical texttranslated historical text:running translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `border-sky-300/50`。
- translated historical texttranslated historical texttranslated historical texttranslated historical text completed/failed translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text" vs "translated historical texttranslated historical texttranslated historical texttranslated historical text(sky translated historical texttranslated historical text sky-300 vs emerald-300)"。
- `Loader2` translated historical text spinner translated historical text header,translated historical texttranslated historical texttranslated historical texttranslated historical text header translated historical texttranslated historical text chip translated historical text badge translated historical texttranslated historical text。

### translated historical texttranslated historical text
- Running translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- Reduced-motion translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text sky translated historical text。
- translated historical texttranslated historical text running,idle/completed/failed translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
translated historical texttranslated historical text `packages/dashboard/src/components/ui/border-beam.tsx`(translated historical texttranslated historical texttranslated historical text,shadcn translated historical texttranslated historical text):
```tsx
type Props = {
  className?: string
  duration?: number      // translated historical text,translated historical texttranslated historical text 8
  colorFrom?: string     // translated historical texttranslated historical text 'hsl(var(--sky-500))'
  colorTo?: string       // translated historical texttranslated historical text 'transparent'
  size?: number          // px,translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text 200
}
// translated historical texttranslated historical text:absolute inset-0 pointer-events-none translated historical text conic-gradient translated historical texttranslated historical text,translated historical text CSS animation translated historical text
```

translated historical text SubAgentCard translated historical text,`status === 'running'` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `<BorderBeam />` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text overlay。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `relative overflow-hidden rounded-lg`。

### translated historical texttranslated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical text Framer Motion**(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。translated historical text**translated historical text CSS**:conic-gradient + `animation: spin`。
- Tailwind v3 translated historical texttranslated historical texttranslated historical text `conic-gradient` translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `style={{ background: 'conic-gradient(...)' }}`。
- `@media (prefers-reduced-motion: reduce)` → `animation: none`,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text sky。

### translated historical texttranslated historical text
- translated historical texttranslated historical text `border-beam.test.tsx`:mount translated historical text `[data-testid=border-beam]` translated historical texttranslated historical text,`prefers-reduced-motion` mock translated historical text**translated historical text**translated historical texttranslated historical text beam。
- translated historical texttranslated historical text `SubAgentCard.test.tsx`:running translated historical texttranslated historical texttranslated historical texttranslated historical text beam,completed/failed translated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical text。translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text:translated historical text #1 translated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical text #1 translated historical texttranslated historical texttranslated historical text SubAgentCard translated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text nested transcript translated historical texttranslated historical texttranslated historical texttranslated historical text)。translated historical texttranslated historical text #1 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## #5 Number Ticker

### translated historical texttranslated historical text
- `TasksButton.tsx` line 70-74:`{total} Tasks · {done}/{total}` translated historical texttranslated historical texttranslated historical texttranslated historical text。
- `BackgroundTerminalPanel.tsx` line 86-88:`{rows.length} Shells` translated historical texttranslated historical text。
- `SubAgentCard.tsx` line 219/342-345:`${turns} turns · ${duration}` translated historical texttranslated historical text(duration translated historical text elapsed clock,turn translated historical texttranslated historical texttranslated historical text)。

### translated historical texttranslated historical text
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,60fps tween translated historical texttranslated historical texttranslated historical texttranslated historical text(200-400ms)。
- Reduced-motion translated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical text**translated historical text tween;translated historical texttranslated historical text(translated historical text session)translated historical text tween,translated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
translated historical texttranslated historical text `packages/dashboard/src/lib/useNumberTicker.ts`:
```ts
export function useNumberTicker(
  target: number,
  opts?: { durationMs?: number; disabled?: boolean }
): number
// translated historical texttranslated historical texttranslated historical texttranslated historical text tween translated historical text(translated historical texttranslated historical text)。target translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text rAF tween,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text target。
// prefers-reduced-motion translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text target。
```

translated historical texttranslated historical texttranslated historical texttranslated historical text `{count}` translated historical text `{useNumberTicker(count)}`,translated historical texttranslated historical text `<Ticker value={count} />` translated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text memo)。

### translated historical texttranslated historical texttranslated historical texttranslated historical text
- `easeOutCubic`。
- translated historical text `useReducedMotion()` translated historical text mediaquery translated historical texttranslated historical text。
- translated historical text `startedAt` / `from` / `to` in ref,rAF translated historical texttranslated historical text。
- translated historical texttranslated historical text unmount translated historical text cancel rAF。

### translated historical texttranslated historical text
- translated historical texttranslated historical text `useNumberTicker.test.ts`:
  - `target=10`,`durationMs=100`,`vi.advanceTimersByTime(50)` → translated historical texttranslated historical text (0, 10) translated historical texttranslated historical text。
  - `advanceTimersByTime(150)` → translated historical text === 10。
  - target translated historical text 10 → 5:translated historical texttranslated historical texttranslated historical texttranslated historical text 5。
  - `prefers-reduced-motion` mock:target=10 translated historical texttranslated historical texttranslated historical texttranslated historical text 10。

### translated historical texttranslated historical text
- translated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text:translated historical text #4 translated historical texttranslated historical text
translated historical texttranslated historical text,translated historical text #4 translated historical texttranslated historical texttranslated historical text SubAgentCard translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## #6 View Transitions API translated historical texttranslated historical text

### translated historical texttranslated historical text
- `InspectorPanel.tsx` line 173 translated historical text `setInspectorView(tab)` translated historical texttranslated historical texttranslated historical text。
- `SubAgentCard.tsx` line 189 translated historical text `setOpen((v) => !v)` translated historical texttranslated historical texttranslated historical text。
- app.tsx translated historical text 7 translated historical text Dialog translated historical text `onOpenChange` translated historical text Radix translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical text CSS translated historical texttranslated historical text)。
- Workspace translated historical texttranslated historical text(`selectSession` translated historical text chatItems translated historical texttranslated historical text)translated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical text View Transitions API translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- Chrome / Safari / Edge translated historical texttranslated historical texttranslated historical text,Firefox translated historical texttranslated historical text —— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text setState。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
translated historical texttranslated historical text `packages/dashboard/src/lib/viewTransition.ts`:
```ts
export function withViewTransition(fn: () => void): void {
  const anyDoc = document as any
  if (typeof anyDoc.startViewTransition !== 'function') {
    fn()
    return
  }
  anyDoc.startViewTransition(() => {
    flushSync(fn)
  })
}
```

translated historical texttranslated historical texttranslated historical texttranslated historical text `setInspectorView(tab)` → `withViewTransition(() => setInspectorView(tab))`。translated historical texttranslated historical text SubAgentCard translated historical text `setOpen`、workspace translated historical texttranslated historical text。

### translated historical texttranslated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical text `flushSync`**,translated historical texttranslated historical text React 18 translated historical text batch,VT translated historical texttranslated historical texttranslated historical text before/after。
- CSS translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text override:`::view-transition-old(root), ::view-transition-new(root) { animation-duration: 200ms; }`(translated historical texttranslated historical texttranslated historical text css)。
- **translated historical texttranslated historical text Dialog**,Radix translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical texttranslated historical text `viewTransition.test.ts`:
  - `document.startViewTransition` translated historical texttranslated historical texttranslated historical texttranslated historical text,fn translated historical texttranslated historical texttranslated historical texttranslated historical text。
  - translated historical texttranslated historical texttranslated historical text,`startViewTransition` translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text fn。
- translated historical texttranslated historical text `InspectorPanel.test.tsx`:translated historical texttranslated historical text tab translated historical text(mock startViewTransition)translated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical text jsdom translated historical texttranslated historical text,translated historical text fallback,translated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text:translated historical text #2 translated historical texttranslated historical text
palette translated historical text "translated historical texttranslated historical text session #X" / "translated historical text tab" translated historical texttranslated historical texttranslated historical texttranslated historical text withViewTransition。#2 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## #7 Streamdown for streaming markdown

### translated historical texttranslated historical text
- `session.ts` line 93/104-159:streaming text translated historical texttranslated historical text `streamBufferRef` + rAF drain translated historical text `streamingText` state。
- `ChatPanel.tsx` line 586-619:`AssistantMarkdown` translated historical text `react-markdown` + `remark-gfm` translated historical texttranslated historical text。
- **translated historical texttranslated historical texttranslated historical text**:streaming translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text ` ``` ` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `**` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical texttranslated historical text markdown translated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text raw text translated historical text pending translated historical texttranslated historical text)。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text assistant translated historical texttranslated historical text)translated historical texttranslated historical text react-markdown(streamdown translated historical texttranslated historical text react-markdown,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。

### translated historical texttranslated historical text
- **translated historical texttranslated historical texttranslated historical texttranslated historical text**:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text LLM streaming translated historical texttranslated historical text,translated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text"。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:`pnpm add streamdown`,translated historical texttranslated historical text `packages/dashboard/src/features/chat/StreamingMarkdown.tsx` translated historical texttranslated historical text,translated historical texttranslated historical text `ChatPanel` translated historical text"translated historical texttranslated historical text streaming translated historical texttranslated historical text bubble" translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `AssistantMarkdown`)。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:**translated historical texttranslated historical texttranslated historical texttranslated historical text**,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"。

### translated historical texttranslated historical text
- translated historical texttranslated historical texttranslated historical text:`StreamingMarkdown.test.tsx` translated historical text:
  - translated historical texttranslated historical text ` ```typescript\nconst x` (translated historical texttranslated historical texttranslated historical text) → translated historical text crash,translated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text DOM)。
  - translated historical texttranslated historical text `**bold ` (translated historical texttranslated historical texttranslated historical text) → translated historical texttranslated historical texttranslated historical text raw text translated historical text pending translated historical texttranslated historical text。

### translated historical texttranslated historical text
- translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text"。

### translated historical texttranslated historical text:translated historical text #1 translated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text message rendering translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical text#1 translated historical texttranslated historical text memo/virtualization,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text (2026-07-07 measurement pass)
**Deferred.** After #1 landed, `AssistantMarkdown` is `React.memo`'d and lives inside a
Virtuoso viewport, so historical assistant bubbles no longer re-parse on scroll and
non-visible bubbles don't render at all. The remaining candidate for flicker is the
*currently streaming* bubble, which re-parses the whole growing string on each
rAF drain. Empirically this is not visually distracting at typical LLM token
rates (~30–60 tok/s) — the DOM churn is bounded by markdown structure, not
token count, and browser paint coalesces intermediate frames.

**Trigger to revisit:** if a user reports visible layout jump/flicker mid-stream,
or if we switch to a provider whose deltas arrive faster than 100 tok/s, do the
measurement:

```ts
// Temporary instrumentation inside AssistantMarkdown:
const t = performance.now()
useEffect(() => {
  const dt = performance.now() - t
  if (dt > 8) console.warn('slow markdown parse', dt.toFixed(1), 'ms', text.length, 'chars')
})
```

If p95 parse time exceeds one frame (~16ms) for streamed lengths, revive this
item — install `streamdown` and swap the streaming bubble's renderer only,
leaving completed bubbles on `react-markdown`.

---

## #8 Shiki syntax highlighting

### translated historical texttranslated historical text
- `AssistantMarkdown` translated historical text `components.pre` slot(ChatPanel.tsx line 605-611)translated historical texttranslated historical texttranslated historical text pre translated historical text ScrollArea,**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**。
- translated historical texttranslated historical texttranslated historical text prism / hljs / shiki。
- `DiffPreview.tsx` translated historical texttranslated historical text TODO translated historical texttranslated historical text:"Syntax highlighting via shiki is a planned follow-up"。

### translated historical texttranslated historical text
- translated historical texttranslated historical text markdown code block translated historical text shiki translated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text tailwind theme translated historical texttranslated historical text(translated historical texttranslated historical text `github-dark` + `github-light`)。
- translated historical texttranslated historical texttranslated historical texttranslated historical text lazy load(translated historical texttranslated historical text bundle translated historical texttranslated historical text 100+ translated historical texttranslated historical text)。
- Unknown language fallback translated historical texttranslated historical texttranslated historical texttranslated historical text。

### translated historical texttranslated historical text
translated historical texttranslated historical text `packages/dashboard/src/features/chat/CodeBlock.tsx`:
```tsx
type Props = {
  code: string
  lang?: string   // translated historical text markdown fence translated historical text,translated historical text:'typescript'
}
// translated historical texttranslated historical text:translated historical texttranslated historical text import shiki/bundle/web,useEffect translated historical text highlight,translated historical texttranslated historical text HTML。
```

translated historical text `AssistantMarkdown` translated historical text `NestedMessage` translated historical text `components.code` slot translated historical texttranslated historical texttranslated historical text inline vs block code(react-markdown translated historical text code translated historical texttranslated historical text signature translated historical text `className` translated historical text `language-xxx` translated historical texttranslated historical text block)。Block translated historical texttranslated historical text `<CodeBlock>`,inline translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

**translated historical texttranslated historical texttranslated historical texttranslated historical text `DiffPreview`**,translated historical text TODO translated historical texttranslated historical text shiki translated historical texttranslated historical texttranslated historical text(diff translated historical texttranslated historical texttranslated historical text shiki translated historical text `diff` translated historical texttranslated historical text grammar)。

### translated historical texttranslated historical texttranslated historical texttranslated historical text
- `pnpm add shiki`(~200KB wasm,translated historical texttranslated historical text fetch)。
- translated historical text `shiki/bundle/web` translated historical text `createHighlighter` + lazy `loadLanguage`。
- Highlighter translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical text**,translated historical texttranslated historical texttranslated historical text CodeBlock translated historical texttranslated historical text。translated historical text `lib/shiki.ts` translated historical text memo。
- translated historical texttranslated historical texttranslated historical texttranslated historical text:`useEffect` translated historical texttranslated historical text dark-mode class translated historical texttranslated historical text,translated historical texttranslated historical text highlight(translated historical texttranslated historical texttranslated historical text shiki translated historical texttranslated historical texttranslated historical texttranslated historical text `defaultColor: false` translated historical texttranslated historical text `--shiki-light` / `--shiki-dark` CSS vars)。**translated historical texttranslated historical texttranslated historical texttranslated historical text**,translated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:`loadingElement={<pre>{code}</pre>}` translated historical texttranslated historical texttranslated historical texttranslated historical text raw code。

### translated historical texttranslated historical text
- translated historical texttranslated historical text `CodeBlock.test.tsx`(mock shiki):
  - translated historical texttranslated historical texttranslated historical texttranslated historical text(typescript)translated historical texttranslated historical texttranslated historical text `<span style>` translated historical text HTML。
  - translated historical texttranslated historical texttranslated historical texttranslated historical text fallback pre + code。
  - translated historical texttranslated historical text unmount translated historical texttranslated historical text setState(translated historical texttranslated historical text warning)。
- translated historical texttranslated historical text `AssistantMarkdown` snapshot:code block translated historical text CodeBlock translated historical texttranslated historical text。

### translated historical texttranslated historical text
- Bundle size:200KB wasm translated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text scroll translated historical texttranslated historical text code block translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text,translated historical text**translated historical texttranslated historical texttranslated historical text**,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- SSR / test:jsdom translated historical text wasm。translated historical texttranslated historical text mock shiki module。

### translated historical texttranslated historical text:translated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical text 7 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## Rollout translated historical texttranslated historical texttranslated historical texttranslated historical text

| translated historical texttranslated historical text | translated historical texttranslated historical text | translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
|---|---|---|---|
| 1 | #1 | translated historical texttranslated historical texttranslated historical text transcript | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text ChatPanel,translated historical texttranslated historical text list translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 2 | #3 | Sonner toast | translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text action translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 3 | #2 | Cmd+K palette | translated historical texttranslated historical text #1 translated historical text scrollToIndex + #3 translated historical text notify |
| 4 | #6 | View Transitions | translated historical texttranslated historical text #2 palette translated historical text setState translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 5 | #4 | Animated Beam | SubAgentCard translated historical texttranslated historical text,translated historical texttranslated historical text |
| 6 | #5 | Number Ticker | translated historical texttranslated historical texttranslated historical text SubAgentCard / TasksButton translated historical texttranslated historical texttranslated historical texttranslated historical text |
| 7 | #7 | Streamdown | translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text |
| 8 | #8 | Shiki | translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical text |

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
