---
name: dashboard-product-screenshot-capture
description: Capture deterministic Light and Dark Dashboard product images from privacy-safe production-component fixtures.
---

# Dashboard product screenshot capture

Use this procedure to regenerate public Dashboard product evidence after a
verified UI or fixture change.

## Inputs

- `<REPOSITORY_ROOT>`: current checkout.
- `<PROTOTYPE_ORIGIN>`: loopback prototype origin.
- `<CAPTURE_SCRIPT>`: repository screenshot command.
- `<OUTPUT_DIRECTORY>`: public optimized-image directory.
- `<MANIFEST_PATH>`: generated capture manifest.
- `<PRIVACY_POLICY_PATH>`: approved public binary Hash registry.

Do not capture a real account, service, repository path, notification, browser
profile, or Session. Only capture `prototype-*` fixtures whose content passed
the repository privacy gate.

## Procedure

1. Confirm the prototype uses production Dashboard components and deterministic
   fictional data. Review visible Session titles and messages as product copy,
   not as internal test labels.

2. Define each scene once and capture both `light` and `dark` themes from the
   same fixture state. Never simulate themes with CSS image filters.

3. Capture the required viewport matrix:

   - `<DESKTOP_VIEWPORT>`;
   - `<TABLET_VIEWPORT>`;
   - `<MOBILE_VIEWPORT>`.

   Set viewport, color scheme, fixed time, Session ID, and UI state before
   waiting for the scene-ready selector.

4. Enforce scene-specific gates before writing an image:

   - Desktop scenes use Full Mode Composer;
   - message navigation is present when required;
   - Tool groups satisfy the scene's minimum call count;
   - Ask User and delegated-agent cards are complete;
   - fonts and product assets have finished loading;
   - no error toast, transport failure, or placeholder skeleton is visible.

5. Write optimized WebP output directly to `<OUTPUT_DIRECTORY>`. Do not commit
   raw PNGs, browser profiles, trace archives, or intermediate captures.

6. Generate `<MANIFEST_PATH>` with filename, theme, viewport, fictional
   Session ID, byte size, and SHA-256 for every image.

7. Visually inspect representative Light and Dark Desktop images plus Tablet
   and Mobile images. Check conversation order, readable text, clipping,
   Composer controls, Session titles, Tool summaries, and outer framing.

8. Approve only the final image Hashes in `<PRIVACY_POLICY_PATH>`, then run the
   repository privacy gate. Do not recapture after Hash approval unless the
   visible output must change.

## Visual contract

- Light and Dark website themes display their matching captures.
- Product images retain intentional image radius.
- Dark feature images have no extra colored border, background frame, padding,
  or shadow unless the design explicitly calls for a device frame.
- Responsive captures show the same fictional Session at each viewport.
- Public assets stay small enough for source-controlled static hosting.

## Failure handling

- Treat a capture gate failure as a fixture or UI defect; do not weaken the
  gate to produce an image.
- If output changes unexpectedly, compare visible pixels and fixture state
  before updating Hashes.
- Never bypass the privacy gate or upload an unreviewed image.
