# Critical User Action Acceptance Matrix

**Status:** normative user-journey acceptance criteria
**Authority:** verification policy is owned by [`../meta/testing.md`](../meta/testing.md); mode behavior is owned by [`../architecture/deployment-mode-contract.md`](../architecture/deployment-mode-contract.md)
**Last reviewed:** 2026-08-14

A visible control is not accepted because it renders or opens. Every critical control must complete its user-visible task through UI, transport, backend prerequisites, persistence, failure handling, and recovery.

| Mode | User entry | Required end-to-end proof | Required automated proof |
|---|---|---|---|
| SaaS | Register/sign in | Branded IdP → callback → account identity visible → Unit loaded on shared product Origin | isolated temporary identity browser flow |
| SaaS | Sign out | POST logout → cookie cleared → signed-out page → second tab exits → cache locked → API 401 | desktop and mobile multi-tab browser flow |
| Both | Account/settings entry | Account identity in SaaS; Settings opens, body scrolls, actions have success/error/retry; Standalone has no false account requirement | Settings component tests plus desktop/mobile task chain |
| Both | Add Workspace | UI opens → invite 200 → no placeholder token → release assets 200 → external Executor connects → invite consumed → Workspace appears → reconnect with long-term token | isolated Workspace and Executor process |
| Both | New Workspace Session | Select online Workspace → validate cwd → create ACK/ready → composer ready → persisted after reload | real Socket.IO + persistence browser flow |
| Both | Send direct message | Persisted queue acceptance ACK under 500 ms → input clears immediately → no timeout restore → Agent turn starts once | real Host/LLM flow; no synthetic UI-only ACK |
| Both | Queue message | Queue dock appears → edit/reorder/delete ACK → drains after active turn → survives/reconciles reconnect | transport fault and reload flow |
| Both | File | Unit-scoped list/read/write/download, binary and large-file behavior, actionable failure, no path escape | real Executor and sandbox |
| Both | Git | Real repository status/diff/refresh including unavailable/empty/error states | real Executor repository |
| Both | Shell | Foreground tool and interactive/background terminal run, stream, resize/cancel/close, reconnect cleanup | real Executor process and Socket.IO |
| Both | Artifact preview | Register → thumbnail → preview → download → reload persistence → cross-Unit denial in SaaS | real artifact bytes and two-Unit denial |
| Both | Agent tool chain | Agent invokes read/write/shell/test tools, observes durable result, and replies once | real LLM or controlled protocol provider with actual tools |
| Both | Sub-agent | Running/success/failure/cancel states remain in parent transcript; no app-level notification; compact/dot interaction works | live child Session browser flow |
| Both | Streaming scroll | User scrolls upward while tokens/tools append → viewport remains pinned to chosen history position → explicit return-to-bottom works | real browser input during active stream |
| Both | Notifications | One System Notifications concept; enable/deny/error; per-kind preferences; current device registration; remote device toggle/test/remove; badge clears on entry | browser permission/service-worker lane and Unit-scoped device API |
| Both | PWA | Manifest/SW load without auth redirect; update/offline banners; notification click navigation; cache identity partition and logout cleanup | production SW in Chromium plus real-device iOS release check |
| Standalone | Benchmark/Evaluation | Navigation/actions visible; default wizard completes; progress and artifacts persist | Standalone benchmark smoke |
| SaaS | Benchmark/Evaluation | Absent from nav/routes/commands/Settings; every raw HTTP and protocol action denied | enumerated deny matrix, not one representative route |
| Both | Responsive surfaces | Settings, Session Settings, image preview, task panel, drawers and alerts fit; body scrolls; header/footer remain operable; keyboard/safe-area behavior | 320×568, 375×667, 390×844 PWA, 430×932, desktop |

## Coverage status semantics

The executable coverage ledger is [`system-e2e-coverage-ledger.md`](system-e2e-coverage-ledger.md). A row is `complete` only when its automated proof satisfies the production-artifact reality standard in [`product-e2e-harness.md`](product-e2e-harness.md). Component tests, fixture-driven browser checks, endpoint probes, and manual production observations may be listed as supporting evidence but cannot change a row to `complete`.

## Feature-state rule

Every prerequisite-dependent visible feature must cover:

1. loading;
2. success;
3. empty;
4. unsupported/disabled;
5. error with actionable explanation;
6. retry or recovery;
7. persistence/reload where the action is durable.

## Failure rules

- Placeholder credentials, tokens, URLs, IDs, or commands must never look executable.
- Raw backend JSON errors must be converted to actionable UI with retry.
- Browser acceptance records console errors, failed requests, screenshots, persisted side effects, and cleanup.
- Tests use dedicated temporary accounts, Sessions, Workspaces, artifacts, device subscriptions, and filesystem roots; never existing user data.
- UI snapshots and geometry checks supplement but do not replace task-chain execution.
- Mock providers may prove protocol behavior only and must be labeled; they do not prove real-provider compatibility.

## Release evidence

Each release candidate records:

- source revision and deployment image/bundle digest;
- test/script identifiers and exact modes;
- isolated resource IDs and cleanup result;
- screenshot paths for desktop/mobile/PWA;
- failed-request and console-error summaries;
- capabilities payload and raw disabled-feature denial results;
- untested real-device or external-provider risks.
