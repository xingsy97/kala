# Linux Portable OCI image

This directory packages the **existing Portable CJS release asset** in a minimal Node.js 22 runtime. It does not rebuild application code. Always build from the repository root so `COPY release/kala-dashboard-with-runtime.cjs` and this Dockerfile come from the same checked-out revision:

```sh
TAG=v0.3.0-beta.1
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

- Runs as the base image's unprivileged `node` user.
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
  ghcr.io/<owner>/<repository>-portable:v0.3.0-beta.1
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
  --tag v0.3.0-beta.1 \
  --revision "$(git rev-parse HEAD)" \
  --output portable-container-evidence.json
```

It verifies the `linux/amd64` image metadata, non-root user, persistent volume declaration, loopback-only publication, `/runtime/capabilities` Portable identity, embedded Dashboard HTML, and Session survival across container replacement. It creates a randomly named network, volume, and two containers labeled with its own project ID; cleanup addresses only those exact resources. It uses a synthetic, nonfunctional model key and sends no model request.

## Release CI integration

After native/CJS release assets for the exact tag and revision exist, the parent release workflow should:

1. Run the artifact inspection command above.
2. Resolve and policy-approve the Node 22 Debian slim digest for `linux/amd64`.
3. Build exactly one `linux/amd64` image with all build arguments above. Do not advertise arm64 until it has equivalent acceptance evidence.
4. Push the immutable version tag, capture the registry digest, and use `name@sha256:...` for every later step.
5. Run the guarded acceptance script against that digest on an isolated VM/runner.
6. Generate an SPDX or CycloneDX SBOM for the digest and attach/attest it.
7. Sign the digest (not a mutable tag), verify the signature and identity policy, then publish the digest, SBOM reference, signature verification result, CJS SHA-256, revision, and acceptance evidence in release metadata.

No workflow files are changed by this infrastructure; the parent release owner must wire these steps into the release and promotion gates.
