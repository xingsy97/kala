# Dashboard Migration Plan — translated historical text demo look translated historical text business product

Target translated historical texttranslated historical text:`open-webui/open-webui`(Svelte,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)translated historical text `janhq/jan`(React + shadcn + Tauri,translated historical texttranslated historical texttranslated historical text)。

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text React + Tailwind + `packages/dashboard/src/components/ui/*`(shadcn translated historical texttranslated historical texttranslated historical texttranslated historical text),translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text **Jan-style / shadcn translated historical texttranslated historical text token translated historical texttranslated historical text** —— translated historical texttranslated historical text (a) translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text shadcn translated historical texttranslated historical text,(b) React translated historical texttranslated historical texttranslated historical texttranslated historical text,(c) Jan translated historical text `bg-secondary` / `bg-card` / `--sidebar` translated historical texttranslated historical texttranslated historical text open-webui translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## translated historical texttranslated historical texttranslated historical texttranslated historical text

1. **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。** translated historical texttranslated historical text kernel/host/protocol translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `packages/dashboard/**`。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text gate translated historical texttranslated historical text "protocol event translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text"。
2. **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。** Jan translated historical texttranslated historical texttranslated historical text `#194D24` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `--primary` + `--sidebar` translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
3. **translated historical texttranslated historical texttranslated historical texttranslated historical text "translated historical texttranslated historical texttranslated historical text demo" translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text):
   - translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、tool call translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text collapsible card)
   - Sidebar translated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text、translated historical text hover translated historical texttranslated historical text、rename translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text inline)
   - Composer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical text focus ring translated historical texttranslated historical text)

---

## Phase 0 — translated historical texttranslated historical text token translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text)

**translated historical texttranslated historical text**:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `bg-slate-950 / text-slate-100 / border-slate-200` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text shadcn translated historical texttranslated historical text token,translated historical texttranslated historical text dark/light translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text phase translated historical texttranslated historical texttranslated historical text。

### 0.1 CSS translated historical texttranslated historical texttranslated historical text(`packages/dashboard/src/index.css`)

translated historical texttranslated historical texttranslated historical texttranslated historical text `@layer base { :root { ... } .dark { ... } }`,translated historical texttranslated historical text Jan translated historical texttranslated historical texttranslated historical text:

```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);         /* translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text */
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);

  /* translated historical texttranslated historical text sidebar translated historical texttranslated historical text —— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text */
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);

  --radius: 0.625rem;
  --font-size-base: 14px;  /* translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text */
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);

  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}
```

### 0.2 Tailwind config(`packages/dashboard/tailwind.config.ts`)

`theme.extend.colors` translated historical texttranslated historical text `background / foreground / card / primary / secondary / muted / accent / destructive / border / input / ring / sidebar`,translated historical texttranslated historical texttranslated historical text `hsl(var(--*))` / `oklch(var(--*))`。translated historical texttranslated historical texttranslated historical texttranslated historical text slate translated historical texttranslated historical texttranslated historical text alias。

### 0.3 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text)

`packages/dashboard/scripts/token-migrate.mjs`:codemod translated historical text `bg-slate-950` → `bg-background`, `bg-slate-900` → `bg-card`, `text-slate-100` → `text-foreground`, `text-slate-500` → `text-muted-foreground`, `border-slate-800` → `border-border`。translated historical texttranslated historical text grep translated historical texttranslated historical texttranslated historical text slate,translated historical texttranslated historical texttranslated historical texttranslated historical text。

**Gate**:`pnpm --filter @agent-kernel/dashboard build` translated historical texttranslated historical text、`pnpm --filter @agent-kernel/dashboard test` 65/65 translated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical text smoke translated historical text console error、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。

---

## Phase 1 — Shell / Layout(translated historical texttranslated historical texttranslated historical texttranslated historical text)

### 1.1 App shell

**translated historical texttranslated historical texttranslated historical texttranslated historical text**:`packages/dashboard/src/app.tsx`

- translated historical texttranslated historical text shadcn `<SidebarProvider>` + `<Sidebar variant="inset" collapsible="icon">`(translated historical texttranslated historical texttranslated historical text Jan translated historical text `offcanvas` —— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。translated historical texttranslated historical texttranslated historical texttranslated historical text `ResizablePanelGroup` translated historical texttranslated historical text `ResizablePanel(defaultSize=14)` translated historical texttranslated historical text Explorer translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text shadcn Sidebar translated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical text `<SidebarInset>` + `ResizablePanelGroup`(inspector translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。
- translated historical texttranslated historical text `WorkbenchToolbar` translated historical texttranslated historical text:translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text `bg-background/60 backdrop-blur-md border-b border-border/60` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `h-10` translated historical texttranslated historical text `h-12` translated historical texttranslated historical text shadcn translated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical text `ConnectionStatus`:translated historical texttranslated historical text Jan translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text + `<Kbd>` translated historical texttranslated historical text。

### 1.2 Explorer → Sidebar

**translated historical texttranslated historical texttranslated historical texttranslated historical text**:`packages/dashboard/src/features/explorer/Explorer.tsx`

- translated historical text `<SidebarHeader>` / `<SidebarContent>` / `<SidebarGroup>` / `<SidebarGroupLabel>` / `<SidebarMenuButton>` translated historical texttranslated historical texttranslated historical texttranslated historical text。
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**(open-webui pattern):Today / Yesterday / Previous 7 days / Previous 30 days / older;translated historical texttranslated historical texttranslated historical texttranslated historical text `<SidebarGroupLabel className="pl-2.5 text-xs text-muted-foreground font-medium">`。
- **translated historical texttranslated historical texttranslated historical texttranslated historical text session translated historical text**(Jan pattern):translated historical texttranslated historical text `rounded-md px-3 py-2 mb-1`,`hover:bg-sidebar-accent`,active translated historical text `border-l-2 border-primary`。
- **Inline rename**:translated historical texttranslated historical texttranslated historical text → translated historical texttranslated historical text `<Input autoFocus>`,Enter translated historical texttranslated historical text,Esc translated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text rename dialog)。
- Row-hover translated historical texttranslated historical texttranslated historical texttranslated historical text `<DropdownMenu>` "…" translated historical texttranslated historical text:Rename / Duplicate / Delete(destructive)。
- **translated historical texttranslated historical texttranslated historical texttranslated historical text**:translated historical texttranslated historical text `parentSessionId` translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text 4px + translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text —— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `parentSessionId`,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- New Session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text mount translated historical text `<SidebarHeader>` translated historical texttranslated historical text,`variant="ghost" size="icon"` + `<Plus />` icon,tooltip "New chat"。

### 1.3 WorkspacePicker

translated historical texttranslated historical text shadcn `<Dialog>` translated historical texttranslated historical texttranslated historical text `<Command>` translated historical texttranslated historical text(fuzzy translated historical texttranslated historical text),translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text button translated historical texttranslated historical text。

**Gate**:sidebar translated historical texttranslated historical texttranslated historical text(icon-only translated historical texttranslated historical text)、rename translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、`SidebarProvider` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text localStorage。

---

## Phase 2 — Chat translated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)

### 2.1 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

**translated historical texttranslated historical texttranslated historical texttranslated historical text**:`packages/dashboard/src/features/chat/ChatPanel.tsx`

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `max-w-3xl mx-auto px-4`。translated historical texttranslated historical texttranslated historical text 100% translated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical text demo translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### 2.2 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

translated historical texttranslated historical text **Jan translated historical text `rounded-md` translated historical texttranslated historical texttranslated historical texttranslated historical text + 80% translated historical text + translated historical texttranslated historical texttranslated historical text**:

```tsx
<div className="flex justify-end w-full mb-4 group/message">
  <div className="relative px-3 py-2 rounded-md bg-secondary text-foreground max-w-[80%] whitespace-pre-wrap">
    {content}
  </div>
</div>
```

- Hover translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text action row:Copy / Edit / Fork。`opacity-0 group-hover/message:opacity-100 focus-within:opacity-100 transition-opacity`。
- Edit translated historical texttranslated historical texttranslated historical texttranslated historical text dialog translated historical texttranslated historical text,translated historical text UI translated historical texttranslated historical text;translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text inline textarea。

### 2.3 Assistant translated historical texttranslated historical text

**translated historical texttranslated historical texttranslated historical texttranslated historical text**:translated historical texttranslated historical text **Jan translated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text markdown"translated historical texttranslated historical text**,translated historical texttranslated historical texttranslated historical text open-webui translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical text:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text nesting。

```tsx
<div className="w-full mb-6 group/message">
  <div className="prose prose-sm dark:prose-invert max-w-none">
    <RenderMarkdown content={...} />
  </div>
  {/* action row: copy / regenerate / metadata */}
</div>
```

- translated historical texttranslated historical text `@tailwindcss/typography`。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `mb-6`(translated historical texttranslated historical texttranslated historical text `mb-4` translated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text "assistant" translated historical texttranslated historical text(Jan pattern),translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `text-xs text-muted-foreground`。

### 2.4 Tool call translated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)

**translated historical texttranslated historical texttranslated historical text**:`packages/dashboard/src/features/chat/ToolCallCard.tsx`

translated historical texttranslated historical texttranslated historical texttranslated historical text `ChatPanel` translated historical texttranslated historical texttranslated historical text tool call translated historical texttranslated historical text。translated historical texttranslated historical text Jan translated historical text `<Tool>` translated historical texttranslated historical text:

```tsx
<Collapsible defaultOpen={running || failed}>
  <CollapsibleTrigger className="flex items-center gap-2 text-muted-foreground text-sm hover:bg-secondary/60 rounded-md px-2 py-1 -mx-2 w-full">
    <WrenchIcon className="size-3.5" />
    <span className="capitalize">{statusLabel}</span>
    <span className="font-mono text-foreground">{toolName}</span>
    <ChevronDown className="ml-auto size-3.5 transition-transform data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
  <CollapsibleContent className="ml-2 pl-4 border-l-2 border-dotted border-border">
    <ToolInput input={input} />
    <ToolOutput output={output} />
  </CollapsibleContent>
</Collapsible>
```

- Status 4 translated historical text:`Running x…` / `Awaiting approval` / `x failed` / `Used x`。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(`border-l-2 border-dotted`)translated historical text Jan translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical text tool translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text。
- awaiting-approval translated historical text,icon translated historical text `<ShieldAlertIcon className="text-amber-500" />`,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `ApprovalRow`(inline,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `ApprovalsPanel`)。

**translated historical texttranslated historical text**:`ApprovalsPanel` translated historical text"chat translated historical texttranslated historical texttranslated historical texttranslated historical text stack"translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text tool call translated historical texttranslated historical texttranslated historical text"。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text approve translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### 2.5 translated historical texttranslated historical text

**translated historical texttranslated historical texttranslated historical text**:`packages/dashboard/src/features/chat/EmptyState.tsx`

- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:`mx-auto max-w-2xl mt-24 text-center`
- translated historical texttranslated historical texttranslated historical text `text-3xl font-semibold`:"How can I help?"
- translated historical texttranslated historical texttranslated historical texttranslated historical text 4 translated historical text suggestion cards(hover translated historical text `bg-secondary/50`),translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text composer:translated historical texttranslated historical text "Explain this codebase" / "Find a bug in …" / "Refactor …" / "Add tests for …"。
- translated historical texttranslated historical texttranslated historical texttranslated historical text `text-xs text-muted-foreground`:translated historical texttranslated historical text model + workspace。

### 2.6 Scroll-to-bottom translated historical texttranslated historical text

translated historical texttranslated historical texttranslated historical text `packages/dashboard/src/features/chat/ScrollToBottomFab.tsx`:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text > 200px translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `<Button size="icon" variant="secondary" className="rounded-full shadow-lg">`,translated historical texttranslated historical text smooth scroll translated historical texttranslated historical text。

**Gate**:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、tool call translated historical texttranslated historical texttranslated historical texttranslated historical text 60fps、approve translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text discoverability。

---

## Phase 3 — Composer

**translated historical texttranslated historical texttranslated historical texttranslated historical text**:`packages/dashboard/src/features/chat/Composer.tsx`

### 3.1 translated historical texttranslated historical text

```tsx
<div className="relative rounded-2xl border border-border bg-background focus-within:ring-2 focus-within:ring-ring/50 focus-within:border-primary transition">
  {/* textarea */}
  {/* bottom bar */}
</div>
```

- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `rounded-md` translated historical texttranslated historical text `rounded-2xl`,translated historical texttranslated historical texttranslated historical text Jan/Claude Desktop translated historical texttranslated historical texttranslated historical text。
- **Focus ring translated historical texttranslated historical text**:`focus-within:ring-2 focus-within:ring-ring/50`,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- Drag-drop image:`data-dragging=true` translated historical text `ring-2 ring-ring/50 border-primary`。

### 3.2 Send translated historical texttranslated historical text

**translated historical texttranslated historical text**:translated historical texttranslated historical text **open-webui translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text pill**,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:

```tsx
<Button
  size="icon-sm"
  className="rounded-full bg-foreground text-background hover:bg-foreground/90 mr-1 mb-1"
>
  <ArrowUp className="size-4" />
</Button>
```

- translated historical texttranslated historical texttranslated historical text:`bg-muted text-muted-foreground`。
- translated historical texttranslated historical texttranslated historical text:translated historical texttranslated historical text `variant="destructive"` + `<Square />` icon(cancel button)。

### 3.3 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

translated historical texttranslated historical texttranslated historical text:`[Model] [Approvals] [/compact] [Image] · · · [Send]`

- Model / Approvals picker translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `<DropdownMenu>` + `variant="ghost" size="sm"`,label translated historical text `text-muted-foreground` translated historical texttranslated historical text。
- `/compact` translated historical text dropdown translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,`<Zap className="size-3.5" />` icon。
- Image translated historical texttranslated historical text:`<Paperclip />` icon,translated historical texttranslated historical texttranslated historical texttranslated historical text file picker。
- translated historical texttranslated historical texttranslated historical text `<Separator orientation="vertical" className="h-4 mx-1" />`。

### 3.4 State chips translated historical texttranslated historical text

translated historical texttranslated historical text `composer-state-chips` translated historical texttranslated historical texttranslated historical texttranslated historical text —— translated historical texttranslated historical text;translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text msgs / tokens / cwd(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。

### 3.5 translated historical texttranslated historical texttranslated historical texttranslated historical text

translated historical text composer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(Send translated historical texttranslated historical texttranslated historical texttranslated historical text)translated historical texttranslated historical text `<Kbd>⌘</Kbd><Kbd>↵</Kbd>` translated historical texttranslated historical texttranslated historical texttranslated historical text,Jan pattern。

**Gate**:focus ring translated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical text 3 translated historical texttranslated historical texttranslated historical text(translated historical text/translated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical text)translated historical texttranslated historical text、pasted image tray translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## Phase 4 — Approvals & pressure banner translated historical texttranslated historical text

### 4.1 ContextPressureBanner

translated historical texttranslated historical texttranslated historical text #153 translated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:

- Soft translated historical text `bg-amber-50` → `border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300`(Jan translated historical text warning translated historical texttranslated historical text)。
- Hard translated historical text `bg-rose-50` → `border-destructive/40 bg-destructive/5 text-destructive`。
- translated historical texttranslated historical texttranslated historical text `py-2` translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text banner translated historical texttranslated historical texttranslated historical text `rounded-md mx-3 my-2`(translated historical text chat panel translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)。

### 4.2 Inline approval(translated historical text 2.4 translated historical texttranslated historical text)

`ApprovalsPanel` translated historical texttranslated historical texttranslated historical texttranslated historical text"chat translated historical texttranslated historical text sticky stack"translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text pending translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text",translated historical texttranslated historical text pending translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text ToolCallCard translated historical text。translated historical text pending > 1 translated historical texttranslated historical texttranslated historical text composer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text stack,translated historical texttranslated historical text "Approve all / Reject all" translated historical texttranslated historical text。

### 4.3 DiffPreview translated historical texttranslated historical text

- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `bg-slate-50` → `bg-muted`
- Add / Del translated historical texttranslated historical texttranslated historical texttranslated historical text `bg-emerald-500/10 text-emerald-700` / `bg-destructive/10 text-destructive`,alpha translated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text backing。

---

## Phase 5 — Product polish(translated historical texttranslated historical text demo translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)

### 5.1 Cmd-K translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

**translated historical texttranslated historical texttranslated historical text**:`packages/dashboard/src/features/palette/CommandPalette.tsx`

- translated historical texttranslated historical text `⌘K` translated historical texttranslated historical text(translated historical text `app.tsx` translated historical text keydown listener)。
- translated historical text `<Command>` translated historical texttranslated historical text(shadcn translated historical texttranslated historical text `cmdk` translated historical texttranslated historical text)。
- translated historical texttranslated historical text:
  - "Actions" translated historical text:New chat, Toggle inspector, Toggle theme, /compact, /clear
  - "Sessions" translated historical text:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text
  - "Files" translated historical text:workspace translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `@file` popover translated historical texttranslated historical text)
- Recent translated historical text localStorage,translated historical texttranslated historical text `<Kbd>↑↓</Kbd> <Kbd>↵</Kbd> <Kbd>esc</Kbd>` translated historical texttranslated historical texttranslated historical text。

### 5.2 Toast

translated historical texttranslated historical texttranslated historical text `sonner`?translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:`packages/dashboard/src/lib/toast.ts` + translated historical texttranslated historical text `<Toaster />`。translated historical texttranslated historical text error banner / success message translated historical text inline banner translated historical texttranslated historical texttranslated historical text toast,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### 5.3 Skeleton loaders

translated historical texttranslated historical texttranslated historical text `packages/dashboard/src/components/ui/skeleton.tsx`(translated historical texttranslated historical text `<div className="animate-pulse rounded-md bg-muted" />`)。translated historical texttranslated historical text:
- Chat panel translated historical texttranslated historical texttranslated historical texttranslated historical text
- Explorer session list translated historical texttranslated historical texttranslated historical text
- InspectorPanel translated historical text metadata translated historical text hydrate

### 5.4 Kbd translated historical texttranslated historical text

translated historical text `packages/dashboard/src/components/ui/kbd.tsx`:

```tsx
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}
```

translated historical texttranslated historical texttranslated historical texttranslated historical text:composer send hint、tooltip translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、command palette translated historical texttranslated historical text。

### 5.5 translated historical texttranslated historical text font-size translated historical texttranslated historical text

`packages/dashboard/src/index.css` translated historical texttranslated historical text `--font-size-base` translated historical texttranslated historical texttranslated historical text Settings UI(#131),translated historical texttranslated historical texttranslated historical texttranslated historical text 12/13/14/15/16。translated historical texttranslated historical text `text-*` translated historical texttranslated historical texttranslated historical text Tailwind theme translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### 5.6 translated historical texttranslated historical texttranslated historical texttranslated historical text

`app.tsx` translated historical text `<ChatPanel>` translated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical text `motion/react` translated historical text `<AnimatePresence>` + `initial={{ opacity: 0 }}, animate={{ opacity: 1 }}`,duration 150ms。translated historical text session translated historical texttranslated historical texttranslated historical text hard cut。

### 5.7 translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text)

translated historical texttranslated historical text `--brand` translated historical texttranslated historical texttranslated historical text `:root`,translated historical texttranslated historical text `= var(--primary)`;translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text"AK translated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text),translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text primary translated historical texttranslated historical text。Explorer sidebar translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text background,translated historical text Jan translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## Phase 6 — translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical text)

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text typecheck + test + build:

1. **P0.1** translated historical texttranslated historical texttranslated historical text `index.css` token translated historical text + translated historical texttranslated historical text `tailwind.config.ts`
2. **P0.2** translated historical text codemod,translated historical texttranslated historical text slate → translated historical texttranslated historical text token
3. **P0.3** translated historical texttranslated historical text:test translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、Storybook(translated historical texttranslated historical text)、smoke script
4. **P1.1** translated historical texttranslated historical text shadcn Sidebar translated historical texttranslated historical text(`sidebar.tsx` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text shadcn translated historical texttranslated historical texttranslated historical text)
5. **P1.2** Explorer translated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical text + inline rename + hover menu + translated historical texttranslated historical texttranslated historical text)
6. **P1.3** WorkbenchToolbar translated historical texttranslated historical texttranslated historical text + `<ConnectionStatus>` translated historical texttranslated historical text
7. **P2.1** ChatPanel translated historical texttranslated historical texttranslated historical texttranslated historical text max-w
8. **P2.2** translated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical text wrapper translated historical texttranslated historical text(bubble vs translated historical text)
9. **P2.3** translated historical text `ToolCallCard`,ChatPanel translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text tool translated historical texttranslated historical text
10. **P2.4** ApprovalsPanel translated historical texttranslated historical text:translated historical texttranslated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical text
11. **P2.5** EmptyState + ScrollToBottomFab
12. **P3** Composer translated historical texttranslated historical text + Send translated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
13. **P4** Banner + DiffPreview translated historical texttranslated historical texttranslated historical text
14. **P5.1** CommandPalette
15. **P5.2 - P5.6** Toast、Skeleton、Kbd、font-size translated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical text

---

## translated historical text Phase translated historical texttranslated historical texttranslated historical text Gate

translated historical texttranslated historical text phase translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:

1. `pnpm -r typecheck`
2. `pnpm --filter @agent-kernel/dashboard test`
3. `pnpm --filter @agent-kernel/dashboard build`
4. **translated historical texttranslated historical texttranslated historical text smoke**(headless Chrome):
   - `/tmp/ak-smoke-<phase>.mjs`,translated historical text DOM translated historical texttranslated historical text、translated historical text console error
   - translated historical texttranslated historical text golden path:translated historical texttranslated historical texttranslated historical texttranslated historical text → translated historical texttranslated historical texttranslated historical text → tool translated historical texttranslated historical text → translated historical texttranslated historical texttranslated historical text → /compact
5. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(dark + light + narrow viewport)

---

## Non-goals

- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical text)
- translated historical texttranslated historical text i18n(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `--primary` translated historical texttranslated historical text)
- translated historical texttranslated historical texttranslated historical text `motion/react` translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text opacity/translate translated historical texttranslated historical texttranslated historical texttranslated historical text)
- translated historical texttranslated historical texttranslated historical text TanStack Router(translated historical texttranslated historical text SPA translated historical texttranslated historical text + translated historical texttranslated historical text state)

---

## translated historical texttranslated historical texttranslated historical texttranslated historical text

translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text):

```
@radix-ui/react-collapsible   # ToolCallCard
@tailwindcss/typography       # Assistant markdown
cmdk                          # Command palette
sonner                        # Toast (translated historical texttranslated historical texttranslated historical text)
motion                        # Page transition
```

translated historical texttranslated historical texttranslated historical texttranslated historical text:`lucide-react`, `@radix-ui/*` translated historical texttranslated historical texttranslated historical texttranslated historical text, `tailwind-merge`, `class-variance-authority`。

---

## translated historical texttranslated historical texttranslated historical texttranslated historical text(1 translated historical texttranslated historical text,translated historical text)

| Phase | translated historical texttranslated historical text | translated historical texttranslated historical text |
|---|---|---|
| P0 tokens | 3h | codemod + translated historical texttranslated historical text |
| P1 shell | 6h | sidebar translated historical texttranslated historical texttranslated historical texttranslated historical text |
| P2 chat | 10h | ToolCallCard + translated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical text |
| P3 composer | 4h | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| P4 approvals + banner | 2h | translated historical texttranslated historical texttranslated historical texttranslated historical text |
| P5 polish | 6h | Cmd-K translated historical texttranslated historical text |
| **translated historical texttranslated historical text** | **~31h** | translated historical text 5 translated historical texttranslated historical texttranslated historical texttranslated historical text |

---

## translated historical texttranslated historical text

1. **shadcn Sidebar translated historical texttranslated historical texttranslated historical text ResizablePanel translated historical texttranslated historical text** —— shadcn `SidebarInset` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `ResizablePanelGroup` translated historical texttranslated historical text。translated historical texttranslated historical text:P1.1 translated historical texttranslated historical texttranslated historical texttranslated historical text branch translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text sidebar + translated historical texttranslated historical text ResizablePanel。
2. **`@tailwindcss/typography` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text** —— translated historical texttranslated historical text `prose-code:before:content-none prose-code:after:content-none` translated historical texttranslated historical text override。
3. **Cmd-K translated historical text macOS translated historical texttranslated historical texttranslated historical texttranslated historical text** —— cmdk translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text Windows Ctrl-K。
4. **codemod translated historical texttranslated historical text** —— translated historical texttranslated historical text grep translated historical texttranslated historical text:`grep -r 'slate-\|zinc-\|gray-' packages/dashboard/src` translated historical texttranslated historical text 0。
