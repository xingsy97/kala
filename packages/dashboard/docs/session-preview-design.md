# Human-readable Session Preview

**Status:** normative Dashboard contract

## Purpose

Session Preview exists to answer four questions within a few seconds:

1. Does this Session need attention?
2. What is it currently doing?
3. What did the user most recently ask for?
4. What was the latest meaningful outcome?

It is not a compact transcript, raw event inspector, Tool Call viewer, or Markdown renderer. Detailed messages, Tool inputs/results, traces, and rich content remain available after opening the Session.

## Information hierarchy

The card renders four deterministic layers without an additional LLM request:

1. **Authoritative activity:** `Needs attention`, `Working`, `Completed`, `Idle`, or `Stopped`. Session state and pending calls are authoritative. Historical text must not override current state.
2. **Current request:** the most recent readable user text.
3. **Latest response:** the most recent readable Assistant text.
4. **Activity statistics:** recent Tool Call count, failed Tool count, omitted rich-content count, and queued-message count.

When a Tool is running or waiting for approval, its `_intent` is the activity description when available. Missing Intention falls back to a truthful generic status; the Preview never derives a purpose from Tool parameters.

## Content safety and readability

The Preview must not render or summarize:

- Tool input parameters, commands, paths, tokens, or structured payloads;
- successful Tool Result bodies;
- Thinking blocks;
- raw event names or sequence metadata;
- Mermaid, fenced code, images, arbitrary HTML, or other rich renderers.

Markdown decoration is reduced to plain readable text. Fenced code, diagrams, and images contribute only to a bounded `rich items` count. Failed Tool Results contribute only to a bounded failure count; their raw body is not shown.

User and Assistant summaries are independently bounded and visually clamped. Long Sessions do not increase the number of visible rows or card height.

## Performance contract

Hovering uses the existing control socket and a bounded recent projection. Preview does not subscribe to token-delta events and therefore does not re-render for every streaming chunk. Durable history, appended events, authoritative state, queue snapshots, connect/disconnect, and deletion remain update sources.

The card has no virtual transcript, Markdown parser, Mermaid renderer, syntax highlighter, image viewer, Tool detail renderer, or nested Agent component. Opening and closing a Preview must not select or load the Session workspace.

## Responsive and interaction contract

Desktop hover remains the activation model. Touch surfaces do not synthesize hover Preview behavior. The card:

- opens beside the Session row where space permits and otherwise opens to its left;
- remains within the visible viewport;
- uses a bounded width and content-driven height with a maximum viewport-relative height;
- keeps the full Session name in the title attribute while visually truncating it;
- does not intercept the row's primary activation or cause the first click to be lost;
- remains inspectable while the pointer moves from the row into the card.

## Required verification

Release tests cover:

- current request and latest response extraction;
- Tool Intention priority while running or awaiting approval;
- no Tool parameter or Tool Result leakage;
- rich-content omission without mounting rich renderers;
- failure, queue, idle, completed, running, approval, and error states;
- no token-delta subscription or high-frequency notification;
- cache refresh and stale/live state changes;
- long Session boundedness;
- real Chromium screenshots using real Session history on supported desktop and tablet-pointer layouts;
- Session row click behavior while a Preview is open.
