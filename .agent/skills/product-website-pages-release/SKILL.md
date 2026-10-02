---
name: product-website-pages-release
description: Validate and publish a static product website to GitHub Pages using public Release catalog data.
---

# Product website Pages release

Use this procedure when publishing an approved product website and its
Release-backed Download and Releases pages.

## Inputs

- `<REPOSITORY_ROOT>`: current checkout.
- `<REPOSITORY_SLUG>`: public `owner/repository` identifier.
- `<SITE_ORIGIN>`: final HTTPS website origin.
- `<SITE_BASE>`: Pages base path.
- `<PAGES_WORKFLOW>`: GitHub Pages workflow name.
- `<RELEASE_CATALOG_FALLBACK>`: reviewed local published-release snapshot.

Never place access tokens, private Release data, unpublished assets, customer
content, local paths, or internal origins in the website or Skill. Obtain
credentials from the execution environment and never print them.

## Procedure

1. Resolve the public GitHub Releases API for `<REPOSITORY_SLUG>`.

   - include only entries with `draft: false` and a non-null publication time;
   - accept only valid semantic-version Tags;
   - distinguish Stable from Preview using the public prerelease flag;
   - validate release and asset URLs against `<REPOSITORY_SLUG>`;
   - parse public Release notes from known headings;
   - never infer the supported OS/architecture matrix from asset names.

2. If the API is unavailable, use `<RELEASE_CATALOG_FALLBACK>`. The fallback
   must contain only previously published Releases and reviewed public asset
   links. Surface that fallback was used; do not silently fabricate data.

3. Render Download and Releases from one normalized Catalog:

   - Stable Download remains bound to the latest Stable entry;
   - a `release.published` build may select the matching Stable or Preview
     entry for release notes;
   - use immutable versioned asset URLs;
   - show publication date and Stable/Preview state;
   - exclude Draft, untagged, and unpublished entries.

4. Run static tests, TypeScript, production build, browser matrix for `/` and
   `<SITE_BASE>`, link checks, and repository privacy validation.

5. Review the complete diff. Keep optimized public images and exclude raw
   captures, temporary output, browser profiles, credentials, and local
   deployment artifacts.

6. Commit only after all checks pass. Follow the operator's requested commit
   boundaries and authorship policy. Do not create or modify a Tag or Release
   unless explicitly requested.

7. Push the approved branch, then watch `<PAGES_WORKFLOW>` to completion.
   Confirm the deployed commit SHA matches the pushed commit.

8. Verify `<SITE_ORIGIN>` over HTTPS:

   - Home, Download, Deploy, Security, and Releases return successfully;
   - theme-aware assets and Lightboxes work;
   - Stable/Preview entries, dates, and direct downloads match public GitHub
     Releases;
   - Pages subpath assets and navigation resolve;
   - no private content is publicly reachable.

9. Update the repository Homepage only after the live origin passes all checks.

## Failure handling

- If Pages fails, inspect the exact failed job and fix the source; do not
  rerun repeatedly without understanding the failure.
- If live content is stale, compare workflow SHA, deployed artifact, response
  headers, and immutable asset Hashes.
- If a release asset is absent, fail the build for the affected supported
  download instead of linking to a generic success-looking page.
