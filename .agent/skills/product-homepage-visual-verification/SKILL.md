---
name: product-homepage-visual-verification
description: Verify a static product homepage across themes, viewports, interactions, and product-evidence framing.
---

# Product homepage visual verification

Use this procedure after changing homepage content, CSS, product images,
responsive behavior, or theme handling.

## Inputs

- `<REPOSITORY_ROOT>`: current checkout.
- `<WEBSITE_ORIGIN>`: loopback origin for the production build.
- `<BROWSER_VERIFIER>`: repository browser-matrix command.
- `<DESKTOP_VIEWPORT>`, `<TABLET_VIEWPORT>`, `<MOBILE_VIEWPORT>`: supported
  viewport dimensions.

Use only local builds and public fictional assets. Do not place credentials,
private URLs, analytics identifiers, or local machine paths in screenshots,
logs, or verifier output.

## Procedure

1. Render and build the production website. Serve the build from
   `<WEBSITE_ORIGIN>`; do not verify a stale development or preview process.

2. Confirm the default first-visit theme and a saved user preference
   independently. Verify the theme-color metadata follows the active theme.

3. At every viewport, check:

   - no horizontal overflow;
   - readable navigation and headings;
   - image aspect ratios and intentional crop behavior;
   - stable carousel controls and swipe behavior;
   - keyboard focus order and visible focus treatment;
   - no overlap between copy, screenshots, and controls.

4. Verify every theme-aware product scene uses the visible theme's actual
   image asset. Open each Lightbox and confirm it uses the currently visible
   image, not a hidden Light asset.

5. Check product framing with computed styles:

   - Hero images use the approved radius and theme-specific border;
   - Dark feature-image containers have transparent background, zero border,
     zero padding, and no shadow;
   - device mockups retain only their intentional hardware frame;
   - feature images are large enough to remain legible beside their copy.

6. Exercise carousels, menu, theme toggle, Download mode tabs, copy buttons,
   Lightbox close behavior, and any animated product demonstration.

7. Verify a Pages-style subpath such as `<SITE_BASE>` in addition to `/`.
   Asset, navigation, canonical, and Open Graph URLs must remain correct.

8. Run static content tests, TypeScript, production build, browser matrix, and
   repository privacy gate.

## Acceptance

The homepage is complete only when the browser verifier measures the requested
visual property, not a proxy for it. Add a computed-style, geometry, or
interaction assertion for each fixed regression.

## Failure handling

- Confirm the HTTP-served asset Hash matches the source before diagnosing a
  browser-cache issue.
- Rebuild and restart only the exact local preview process that serves the
  website.
- Do not hide overflow, shrink text, or remove controls merely to make a
  viewport check pass.
