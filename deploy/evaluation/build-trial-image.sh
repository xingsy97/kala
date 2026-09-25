#!/usr/bin/env bash
set -euo pipefail

image_alias="${1:-agent-eval-trial-noble-v1}"
builder=agent-eval-image-builder
# Ubuntu 24.04 amd64 container release 20260801. Resolve through the local
# content-addressed cache so a moving remote alias cannot alter a build.
base_image=local:9c68ebff3356d887806098d468618b53cf4269c9a1173ebdaf9a113aa2cfae64
storage_pool="${AGENT_EVAL_LXD_STORAGE_POOL:-default}"
root=$(cd "$(dirname "$0")/../.." && pwd)
staging=$(mktemp -d "$root/.agent-eval-build.XXXXXX")
cleanup() {
  lxc delete --force "$builder" >/dev/null 2>&1 || true
  rm -rf "$staging"
}
trap cleanup EXIT

if lxc info "$builder" >/dev/null 2>&1; then
  echo "refusing to overwrite existing builder $builder" >&2
  exit 1
fi

pnpm --dir "$root" --filter @agent-kernel/kernel build
pnpm --dir "$root" --filter @agent-kernel/shared build
pnpm --dir "$root" --filter @agent-kernel/executor build
pnpm --dir "$root" --filter @agent-kernel/host build
pnpm --dir "$root" --filter @agent-kernel/eval-agent-runlab build
pnpm --dir "$root" --filter @agent-kernel/eval-agent-codex build
pnpm --dir "$root" --filter @agent-kernel/eval-benchmark-swe-bench build

# jsonc-parser's UMD entry point loads sibling modules with runtime require().
# Keep that package external and install the pinned package beside the bundle so
# Node resolves its complete module tree instead of an incomplete single file.
pnpm --dir "$root" exec esbuild packages/host/bin/agent-kernel-host.ts --bundle --platform=node --target=node22 --format=cjs --external:jsonc-parser --outfile="$staging/agent-kernel-host.cjs"
pnpm --dir "$root" exec esbuild packages/executor/bin/agent-kernel-executor.ts --bundle --platform=node --target=node22 --format=cjs --outfile="$staging/kala-executor.cjs"
pnpm --dir "$root" exec esbuild adapters/agents/agent-runlab/bin/runlab-trial-driver.ts --bundle --platform=node --target=node22 --format=cjs --outfile="$staging/agent-eval-runlab-driver.cjs"
pnpm --dir "$root" exec esbuild adapters/agents/codex/bin/codex-app-server-driver.ts --bundle --platform=node --target=node22 --format=esm --outfile="$staging/agent-eval-codex-app-server.js"
cp "$root/adapters/benchmarks/swe-bench/dist/bin/swe-bench-grade.js" "$staging/agent-eval-swe-bench-grade.js"
cp "$root/deploy/evaluation/install-trial-image.sh" "$staging/install.sh"

lxc init "$base_image" "$builder" --no-profiles --storage "$storage_pool" \
  --device root,size=40GiB \
  --device eth0,network=lxdbr0 \
  --config limits.cpu=4 \
  --config limits.memory=8GiB \
  --config user.agent-eval.managed=true \
  --config user.agent-eval.purpose=image-builder
lxc start "$builder"
ready=false
for attempt in $(seq 1 60); do
  if lxc exec "$builder" -- /bin/sh -c 'command -v apt-get >/dev/null' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then echo "LXD builder did not become ready" >&2; exit 1; fi
lxc exec "$builder" -- mkdir -p /root/agent-eval-install
for asset in agent-kernel-host.cjs kala-executor.cjs agent-eval-runlab-driver.cjs agent-eval-codex-app-server.js agent-eval-swe-bench-grade.js install.sh; do
  lxc file push "$staging/$asset" "$builder/root/agent-eval-install/$asset"
done
lxc exec "$builder" -- bash /root/agent-eval-install/install.sh
lxc stop "$builder"
if lxc image info "$image_alias" >/dev/null 2>&1; then
  echo "refusing to overwrite existing image alias $image_alias" >&2
  exit 1
fi
lxc publish "$builder" --alias "$image_alias" \
  description="Agent Evaluation trial image: Node 22.23.2, Codex 0.146.0, Claude Code 2.1.83, SWE-Bench f7bbbb2"
lxc image info "$image_alias"
