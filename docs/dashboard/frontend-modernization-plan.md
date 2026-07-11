# Dashboard Frontend Modernization Plan
  
  > Scope: `packages/dashboard`
  > Status: Phases 1-4 implemented on 2026-07-11
  > Author: collaborative planning note, 2026-07-11
  
  ## 1. Background and Goals
  
  `packages/dashboard` is a Vite + React 18 single-page application. It subscribes to `packages/host` over Socket.IO and also uses HTTP routes from `packages/host/src/http/routes.ts`. The stack is already mature: Radix UI, Tailwind, shadcn-style local components, `class-variance-authority`, `tailwind-merge`, `cmdk`, `sonner`, and `lucide-react`.
  
  The dashboard is primarily a researcher and developer observability tool. Information density, professional ergonomics, and scan efficiency are more important than decorative polish. That does not mean the UI should feel unfinished. Low-frequency, non-critical moments may use restrained motion or product polish when it improves perceived quality without hiding operational information.
  
  Core principle: keep the work surface quiet, but do not let it feel unfinished.
  
  Goals:
  
  1. Move scattered `useState + fetch + useEffect` data fetching into a mature data layer.
  2. Make list insertion, deletion, and local layout changes feel smooth.
  3. Add typewriter or micro-motion only in places where atmosphere matters more than rapid scanning.
  4. Define where product polish is allowed, so future work does not either overuse effects or ban them entirely.
  
  ## 2. Adoption Plan
  
  ### Phase 1: Auto-animate pilot
  
  Use `@formkit/auto-animate` in a small number of low-risk list surfaces: the chat tasks popover, the background shell list, and the expanded tool-call group in `ChatPanel`. Do not use it for streaming messages, virtualized lists, or toasts.
  
  Acceptance criteria: users perceive smoother transitions, no frame drops, bundle increase remains small, and reduced-motion users get an appropriate fallback.
  
  ### Phase 2: TanStack Query for HTTP data
  
  Move request/response HTTP reads to TanStack Query. Good targets include model lists, file browsing, artifact manifests, benchmark run lists, docs index/content, and memory consolidation result polling. Socket.IO remains the event stream and should not be moved into Query. Socket events may update or invalidate Query cache entries when needed.
  
  Migration strategy: start with one page, establish the provider/loading/error pattern, then migrate page by page.
  
  ### Phase 3: Motion for critical path animation
  
  Use `motion` only on critical UI transitions such as `ContextPressureBanner` or possibly `ComposerFlipContainer` if it simplifies the existing CSS 3D implementation. Do not replace ordinary hover/press transitions or list insertion animations with Motion.
  
  ### Phase 4: Typewriter and caret
  
  Implement a small local typewriter hook rather than adding a package. Use it only for static, first-appearance text such as a new-session empty state, a benchmark empty state, or an error boundary fallback. Do not apply a typewriter effect to real assistant streaming output, loading states, timestamps, inspector JSON, or other high-frequency scan surfaces.
  
  ## 3. Keep As-Is
  
  Keep Radix UI plus shadcn-style local ownership, `react-virtuoso`, `react-arborist`, `shiki`, `react-markdown`, `remark-gfm`, `sonner`, `cmdk`, and the existing theme implementation.
  
  ## 4. Product Polish Policy
  
  Polish is allowed only when three conditions hold:
  
  1. Low frequency: the user sees it a few times per session or at a meaningful milestone.
  2. Not a scan surface: the area is not used for rapid operational comparison.
  3. No conflict with real data signals: motion must not delay, mask, or distort actual runtime progress.
  
  Allowed zones include new-session empty states, command-palette hints, first-connection guidance, benchmark completion milestones, a connection-success pulse, context-pressure warning emphasis, and future external landing or docs pages.
  
  Forbidden zones include assistant streaming text itself, session/task/shell row metadata, inspector JSON, benchmark table cells, loading states, file-tree labels, settings forms, and repeated high-frequency feedback.
  
  ## 5. Scoped Use of UI Libraries
  
  TanStack Router is deferred until shareable deep links, browser history behavior, or nested routes require it. MagicUI may be copied source-by-source only for approved polish zones. Aceternity-style effects are reserved for future external pages. UI generation tools may help with prototypes, but generated code should not be dropped directly into the main workbench.
  
  ## 6. Implementation Record
  
  Phases 1-4 were implemented in one batch:
  
  - `@formkit/auto-animate` added for the tasks list, background shell list, and tool-call group details.
  - `@tanstack/react-query` added with a top-level `QueryClientProvider`; artifact manifest, model loading, and docs index/content moved to Query.
  - `motion` added for `ContextPressureBanner` entry and hard-pressure breathing emphasis.
  - A local `useTypewriter` hook, `Typewriter` component, and caret CSS were added for selected static empty/error states.
  
  Validation at the time: typecheck had no new errors from this work, tests were nearly all passing with one unrelated workspace-rename failure, and Vite build passed.
  
  ## 7. Deferred Work
  
  Remaining candidates: move settings and benchmark mutations to `useMutation`, add typewriter polish to the command palette or connection dialog after design review, and add a benchmark completion number ticker only as a separate milestone effect.
  