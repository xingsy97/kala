---
name: dashboard-ui-mock-harness
description: Build and maintain a privacy-safe Dashboard prototype that exercises production UI with fictional transport data.
---

# Dashboard UI mock harness

Use this procedure when a Dashboard state must be demonstrated or tested
without connecting to a real service, workspace, account, or Session.

## Inputs

- `<REPOSITORY_ROOT>`: current checkout.
- `<PROTOTYPE_ENTRY>`: production Dashboard prototype entry point.
- `<MOCK_TRANSPORT>`: local mock transport implementation.
- `<FIXTURE_SESSION_ID>`: fictional identifier prefixed with `prototype-`.
- `<PROTOTYPE_ORIGIN>`: loopback origin used only for local verification.

Never copy production messages, paths, account names, hostnames, tokens, Session
IDs, or deployment metadata into a fixture. Use fictional workspaces, generic
repository paths, reserved domains such as `placeholder.example`, and fixed
timestamps.

## Procedure

1. Identify the production components and protocol events required by the
   requested state. Do not build a substitute UI that merely resembles them.

2. Add the smallest fictional Session history that naturally produces the
   state:

   - preserve `User → Assistant → Tool result` ordering;
   - place an Assistant response between distinct User messages;
   - use multiple User messages only when testing message navigation;
   - separate ordinary Tool groups from delegated-agent Tool groups;
   - represent pending, completed, failed, and cancelled states explicitly.

3. Derive cursors and counts from fixture messages rather than hard-coding
   offsets. A Tool message advances once for the message and once for each Tool
   result represented by the transport contract.

4. Use realistic task titles derived from the fictional request. Never use
   screenshot annotations such as `long response`, `two decisions`, `UI demo`,
   or `activity matrix` as Session labels.

5. Route the fixture through the production inbound and outbound schemas. The
   harness may replace transport, time, and external I/O, but not component
   behavior or protocol shapes.

6. Start the prototype on `<PROTOTYPE_ORIGIN>` and verify the requested state
   using stable test IDs or accessibility roles. Confirm there are no
   unexpected runtime errors.

7. Run the narrowest Dashboard typecheck and tests covering the changed
   protocol, store, and production components.

8. Run the repository privacy gate before treating the fixture as public
   product evidence.

## Product-evidence gates

- Desktop Full Mode scenes contain the complete Composer controls.
- User-message navigation appears only when the fixture naturally has at least
  two User messages.
- Tool summaries contain enough varied calls to demonstrate grouping without
  manufacturing impossible execution order.
- Ask User requests have explicit options and remain pending until a fictional
  response is submitted.
- Delegated-agent cards are produced from real parent-child protocol records.
- All clocks are deterministic and all visible content is fictional.

## Failure handling

- If the intended UI does not appear, inspect fixture ordering, cursor
  calculation, and protocol validation before changing production visibility
  rules.
- If a privacy check fails, replace the fixture data; never whitelist private
  content.
- Do not commit generated screenshots, push changes, or publish a deployment
  unless the operator explicitly requests those actions.
