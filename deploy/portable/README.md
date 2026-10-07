# Linux Portable OCI image

This directory packages the **existing Portable CJS release asset** in a minimal Node.js 22 runtime. It does not rebuild application code. Always build from the repository root so `COPY release/kala-dashboard-with-runtime.cjs` and this Dockerfile come from the same checked-out revision:

```sh
TAG=v0.3.0-beta.18
VERSION=${TAG#v}
REVISION=$(git rev-parse HEAD)
ASSET=release/kala-dashboard-with-runtime.cjs
ASSET_SHA256=$(sha256sum "$ASSET" | cut -d' ' -f1)

node scripts/release/verify-portable-container.mjs \
  --inspect-artifact --asset "$ASSET" --tag "$TAG" --revision "$REVISION"

docker buildx build --load --platform linux/amd64 \
  --file deploy/portable/Dockerfile \
  --build-arg NODE_IMAGE="node:22-bookworm-slim@sha256:<approved-amd64-digest>" \
  --build-arg KALA_VERSION="$VERSION" \
  --build-arg KALA_REVISION="$REVISION" \
  --build-arg KALA_SOURCE="https://github.com/<owner>/<repository>" \
  --build-arg KALA_CREATED="$(git show -s --format=%cI HEAD)" \
  --build-arg KALA_ASSET_SHA256="$ASSET_SHA256" \
  --tag "ghcr.io/<owner>/<repository>-portable:$TAG" \
  .
```

`Dockerfile.dockerignore` limits this root build context to the CJS asset and this Dockerfile. CI must pin `NODE_IMAGE` by digest; the unpinned default is for readable local inspection, not a release provenance guarantee. The build fails if any required OCI metadata is absent or if the copied asset hash differs.

## Runtime contract

- Builds with pinned official Node 22 and runs on a separately pinned minimal distroless Node 22 runtime as unprivileged numeric user `65532:65532`.
- Listens on container port 3000 (`0.0.0.0` inside the container).
- Sets `HOME=/var/lib/kala` so Sessions, artifacts, audit records, user configuration, credentials, and state reside on the same persistent volume.
- Declares `/var/lib/kala` as a volume.
- Contains no model credentials. Supply credentials at runtime only when an actual model operation requires them.

Bind the published port to loopback by default:

```sh
docker volume create kala-portable-state
docker run --rm --name kala-portable \
  --publish 127.0.0.1:3000:3000 \
  --mount type=volume,source=kala-portable-state,target=/var/lib/kala \
  ghcr.io/<owner>/<repository>-portable:v0.3.0-beta.18
```

Do not publish on all host interfaces without separately designing authentication and network policy.

## Self-contained boundary

The checked CJS has an embedded Dashboard and its basic `--version` path loads under Node.js 22 from a temporary directory with no repository `node_modules`. Core Node modules, including `node:sqlite`, remain runtime dependencies supplied by Node 22. Optional native WebSocket accelerators (`bufferutil` and `utf-8-validate`) and `supports-color` are referenced through optional dependency paths; they are not required for the verified startup path.

This image intentionally adds no Git, browser, model CLI, shell toolchain, workspace content, or user configuration. Consequently, serving the Dashboard and managing Session state can be self-contained while agent workflows that invoke an external executor, Git, GitHub Copilot CLI, or other host tools are **not** proven self-contained. The isolated acceptance below does not claim those workflows.

## Isolated VM acceptance (never run on a developer/Box host)

The acceptance script launches containers and publishes a temporary loopback port. It has a two-part guard and must run only on a disposable, isolated Linux VM/runner with Docker and repository dependencies installed:

```sh
KALA_PORTABLE_CONTAINER_ACCEPTANCE_VM=1 \
node scripts/release/verify-portable-container.mjs \
  --isolated-vm \
  --image "ghcr.io/<owner>/<repository>-portable@sha256:<published-digest>" \
  --tag v0.3.0-beta.18 \
  --revision "$(git rev-parse HEAD)" \
  --output portable-container-evidence.json
```

It verifies the `linux/amd64` image metadata, non-root user, persistent volume declaration, loopback-only publication, `/runtime/capabilities` Portable identity, embedded Dashboard HTML, and Session survival across container replacement. It creates a randomly named network, volume, and two containers labeled with its own project ID; cleanup addresses only those exact resources. It uses a synthetic, nonfunctional model key and sends no model request.

## Candidate release workflow and gate distinctions

`.github/workflows/portable-image-release.yml` is a separate manual workflow for the **private candidate only**. Dispatch it with the workflow ref set to the **same `v0.3.0-beta.18` tag** (not `main`). It accepts exactly that tag, a full 40-hex revision, and an operator-approved official `node:22-bookworm-slim` `linux/amd64` digest. It does not use the workspace `release/` directory: it downloads the CJS, `SHA256SUMS`, `SHA256SUMS.sigstore.json`, and `manifest.json` from the exact draft release into a new temporary directory.

The workflow has three distinct states:

1. **Private candidate controls passed:** the `release.yml` Sigstore identity and signed checksum index, exact manifest/tag revision, embedded CJS metadata, pinned base, one `linux/amd64` image, immutable image signature, provenance, BuildKit SPDX SBOM attestation, and the Private Cloud dual-scanner vulnerability policy passed. Candidate metadata still says `private-candidate-vm-acceptance-pending`.
2. **Isolated-VM accepted:** the GitHub-hosted Ubuntu VM verifies the digest signature and evidence and runs the two-part acceptance guard successfully. Only allowlisted acceptance JSON and signed metadata are uploaded. This is container acceptance, not product/model E2E.
3. **Public promotion:** the candidate workflow records `publicPromotion: false`. After state 2, the promotion workflow independently verifies signed VM acceptance metadata, package visibility and an **anonymous full pull** of the same immutable digest; it rejects a private or substituted image. Do not mistake a published tag for an accepted digest.

`require_isolated_vm_acceptance` defaults to `true`; when VM acceptance fails, no candidate can be promoted. Setting it false produces a private candidate only, with signed metadata that still marks VM acceptance pending. The workflow uses GitHub-hosted runners; no self-hosted runner is required.

Do not run this acceptance on Box or a developer host. Do not interpret a skipped acceptance job or a successfully built image as E2E acceptance.
