# Smooth Streaming Text (controlled reveal rate + per-character fade-in)

## Motivation

When the assistant streams a reply, text currently appears in **bursts**: the
smoother batches characters and commits them to React roughly every ~66ms
(~15fps), and the drain rate is adaptive (`chunkSize = max(2, buffer/10)`). The
result is that a clump of characters pops into the DOM at once, with a hard
opacity cut and an uneven, "one clump at a time" rhythm — it reads as characters
*bursting* out rather than flowing.

We want the stream to feel smooth:

1. Characters reveal **one at a time** at a **controlled, even rate**.
2. Each newly-revealed character **fades in** (opacity only).
3. The reveal stays **as fast as needed to not fall behind the data**, but is
   still rate-controlled (never dumps a whole clump).
4. Already-rendered markdown blocks stay **completely stable** (no re-render /
   flicker), reusing the existing block-split memoization.

This must be a **user-toggleable setting**, **on by default**. Turning it off
restores exactly today's behavior (batched commit, hard-cut characters).

## Non-goals

- No positional motion (no `translateY`/slide) — opacity only, to avoid layout
  and wrapping artifacts.
- No change to the wire protocol or to how the kernel/event-log stay
  authoritative. This is a pure rendering/UX layer over `session:token_delta`.

## Current pipeline (what changes)

`packages/dashboard/src/session.ts`:

- `session:token_delta` → appends to `streamBufferRef`.
- a rAF loop `drainStreamBuffer` pulls `chunkSize` chars/frame into
  `pendingCommit`, and commits to `setStreamingText` at most every `MIN_COMMIT_MS`
  (66ms).

`packages/dashboard/src/features/chat/ChatPanel.tsx`:

- `AssistantMarkdown` splits the streamed text into completed blocks (each a
  memoized `MarkdownBlock`) plus a trailing `MarkdownBody` for the block being
  written. This block-split stays; only the tail rendering gains fade-in.

## Design

Two layers, plus a setting.

### Layer 1 — controlled character-reveal rate (`session.ts`)

Replace the adaptive/batched drain with a **rAF-driven, even-rate character
releaser**. State:

- `bufferedText` — received from the wire but not yet revealed.
- The committed `streamingText` — everything revealed so far (unchanged
  semantics for downstream rendering).

Each animation frame, compute how many characters to release from `dt` (seconds
since last frame) and an **effective** characters-per-second:

```
effectiveCps = clamp(
  max(BASE_CPS, bufferedLength / MAX_LAG_SECONDS),  // catch-up so we never
  BASE_CPS, MAX_CPS,                                //   lag more than MAX_LAG_SECONDS
)
charsThisFrame = floor(effectiveCps * dt + carry)   // carry keeps fractional
                                                    //   chars across frames
```

- **Even pacing**: characters leave at ~`BASE_CPS` when the buffer is small, so
  the rhythm is smooth instead of clumpy.
- **Never fall behind (goal #3)**: if data arrives faster than `BASE_CPS`, the
  buffer grows, which raises `effectiveCps` so the whole backlog is caught up
  within `MAX_LAG_SECONDS`. Because it is still released per-frame at a rate, it
  accelerates smoothly rather than dumping a clump.
- **Bounded speed**: `MAX_CPS` prevents catch-up from itself becoming a burst.
- **Fractional carry**: at low rates a frame may owe <1 char; the fractional
  remainder carries to the next frame so the average rate is exact.
- **End of stream**: when `resetStream()`/`llm_response` fires (the authoritative
  final text arrives), flush any remaining buffer immediately so the final
  message is never truncated; the fade-in still plays for the last window.
- **Empty frames**: if `charsThisFrame === 0`, skip `setState` (no wasted
  re-render).

Cost note: committing per-frame (up to 60fps) instead of 15fps is fine because
the expensive work is already gated by the block-split memoization — only the
tail `MarkdownBody` re-renders; completed blocks never do.

When the setting is **off**, Layer 1 is bypassed and the existing
`MIN_COMMIT_MS` batched drain is used verbatim.

### Layer 2 — per-character fade-in in the tail (`ChatPanel.tsx`)

Markdown can't wrap every character in a `<span>` (it would break parsing and
fight ReactMarkdown). So the fade-in is applied only to a **small sliding window
at the very end of the tail block**:

- The tail text is split into:
  - `settledTail` — the earlier part of the tail (characters that have already
    finished fading). Rendered as **plain text** through markdown.
  - `fadingTail` — the last `FADE_WINDOW_CHARS` characters. Each is wrapped in
    `<span class="ak-char-in" style="animation-delay: …">` so it fades in.
- As new characters arrive, the window slides forward: the oldest fading
  character "graduates" into `settledTail` (becomes plain text) and new
  characters enter the window.

**Performance protection (goal #1):**

- The number of animated spans is **bounded by `FADE_WINDOW_CHARS`** at all
  times, regardless of reply length. A 10k-character reply still has ≤ window
  animated spans at any instant.
- Fade-in is a **pure CSS animation** (opacity only), so it runs on the
  compositor and does not use JS per-frame or the main thread.
- Each character span uses a **stable key** derived from its absolute character
  index, so React never re-triggers a finished animation by reordering.

**Markdown coexistence + safety-net downgrade (accepted):**

- Completed blocks are untouched (already stable).
- The fade window applies to the **plain-text tail**. If the tail's end enters a
  fenced code block or another structural construct (detected the same way
  `splitMarkdownBlocks` tracks fences), the character-level window is **disabled
  for that tail** and it renders as today (a whole-tail soft appearance). This
  guarantees we never corrupt markdown structure; smoothness degrades
  gracefully in those rarer stretches.

When the setting is **off**, Layer 2 renders the tail exactly as today (no
per-character spans).

### Tunable parameters

Centralized constants (exported so they're easy to adjust; no UI yet):

| Constant | Meaning | Default |
|---|---|---|
| `STREAM_BASE_CPS` | base reveal rate (chars/sec) | `120` |
| `STREAM_MAX_CPS` | catch-up ceiling (chars/sec) | `600` |
| `STREAM_MAX_LAG_SECONDS` | max seconds allowed behind the data | `0.4` |
| `STREAM_FADE_WINDOW_CHARS` | simultaneously-fading characters (perf cap) | `48` |
| `STREAM_FADE_DURATION_MS` | per-character fade duration | `180` |

`STREAM_BASE_CPS` is the primary knob the user asked to keep adjustable.

### The setting

A boolean preference, **default on**:

- `prefs.ts`: `smoothStreamingText: { key: 'ak-smooth-streaming-text', type: 'boolean', defaultValue: true }`, exported as `PREF_SMOOTH_STREAMING_TEXT`.
- `SettingsDialog` → Interface section: an `InterfaceToggle`
  ("Smooth streaming text" / description) bound via `useBooleanPref`.
- The flag flows to:
  - `session.ts` (Layer 1: even-rate vs batched drain),
  - `ChatPanel` (Layer 2: per-character fade vs plain tail).

Because `session.ts` owns the reveal loop and reads localStorage-backed prefs,
the flag is read there directly (same mechanism as other prefs); the render flag
is threaded to `ChatPanel` alongside the existing display prefs.

### Reduced motion

`.ak-char-in` respects `prefers-reduced-motion: reduce` (animation disabled →
characters appear instantly). Rate control (Layer 1) still applies; only the
fade is dropped, matching the rest of the app's motion policy.

## Files touched

1. `packages/dashboard/src/session.ts` — even-rate releaser (Layer 1), gated by
   the setting.
2. `packages/dashboard/src/features/chat/ChatPanel.tsx` — tail fade window
   (Layer 2) + safety-net downgrade; new exported constants.
3. `packages/dashboard/src/index.css` — `.ak-char-in` keyframes + reduced-motion.
4. `packages/dashboard/src/lib/prefs.ts` — new boolean pref + exported key.
5. `packages/dashboard/src/features/settings/SettingsDialog.tsx` — Interface
   toggle.
6. `packages/dashboard/src/i18n/resources.ts` — toggle label/description (en/zh).

## Verification (perf-harness)

Extend `packages/perf-harness` streaming scenario to measure:

- **Even pacing**: variance of per-frame revealed-char counts should be low
  (smooth), not "0,0, big clump".
- **Not behind data**: time from "all data delivered" to "all text shown" should
  be within ~`MAX_LAG_SECONDS`.
- **Perf cap**: count of `.ak-char-in` spans at any instant ≤
  `STREAM_FADE_WINDOW_CHARS`, and does not grow with reply length.
- **Earlier content stable**: existing `earlyRegionChanges` stays ≤ threshold.
- **No jank**: under 6× CPU throttle, no long frames.

Plus dashboard unit tests for the tail-splitting/window helper (pure function)
and the setting default.
