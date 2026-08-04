#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <official-oci-image@sha256:digest> <instance-id> <base-commit> <output-alias>" >&2
  exit 2
fi

official_image="$1"
instance_id="$2"
base_commit="$3"
output_alias="$4"
case "$official_image" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "official image must be pinned by sha256 digest" >&2; exit 2;; esac
case "$instance_id" in *[!A-Za-z0-9_.-]*|'') echo "invalid instance id" >&2; exit 2;; esac
case "$base_commit" in *[!A-Fa-f0-9]*|'') echo "invalid base commit" >&2; exit 2;; esac

root=$(cd "$(dirname "$0")/../.." && pwd)
staging=$(mktemp -d "$root/.agent-eval-swebench-build.XXXXXX")
builder="agent-eval-sweb-${instance_id,,}"
builder="${builder//_/-}"
builder="${builder:0:55}"
source_alias="agent-eval-oci-${instance_id,,}"
source_alias="${source_alias//_/-}"
source_alias="${source_alias:0:55}"
storage_pool="${AGENT_EVAL_LXD_STORAGE_POOL:-default}"
: "${AGENT_EVAL_LXD_BUILDER_ADDRESS:?set the temporary LXD builder address}"
: "${AGENT_EVAL_LXD_BUILDER_GATEWAY:?set the temporary LXD builder gateway}"
builder_address="$AGENT_EVAL_LXD_BUILDER_ADDRESS"
builder_gateway="$AGENT_EVAL_LXD_BUILDER_GATEWAY"
crane_binary="${AGENT_EVAL_CRANE_BINARY:-$HOME/go/bin/crane}"
: "${AGENT_EVAL_TOOL_IMAGE:?set a trusted tool image alias or fingerprint}"
tool_image="$AGENT_EVAL_TOOL_IMAGE"
tool_exporter=agent-eval-tool-exporter
source_fingerprint=""

cleanup() {
  lxc delete --force "$builder" >/dev/null 2>&1 || true
  lxc delete --force "$tool_exporter" >/dev/null 2>&1 || true
  if [ -n "$source_fingerprint" ]; then lxc image delete "$source_fingerprint" >/dev/null 2>&1 || true; fi
  find "$staging" -type f -delete >/dev/null 2>&1 || true
  find "$staging" -depth -type d -empty -delete >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ ! -x "$crane_binary" ]; then echo "crane binary not found: $crane_binary" >&2; exit 1; fi
if lxc network list-leases lxdbr0 --format csv | cut -d, -f3 | grep -Fx "$builder_address" >/dev/null; then echo "builder address is already leased: $builder_address" >&2; exit 1; fi
if lxc info "$builder" >/dev/null 2>&1; then echo "refusing to overwrite existing builder $builder" >&2; exit 1; fi
if lxc info "$tool_exporter" >/dev/null 2>&1; then echo "refusing to overwrite existing tool exporter $tool_exporter" >&2; exit 1; fi
if lxc image info "$output_alias" >/dev/null 2>&1; then echo "refusing to overwrite existing image alias $output_alias" >&2; exit 1; fi
if lxc image info "$source_alias" >/dev/null 2>&1; then echo "refusing to overwrite existing source alias $source_alias" >&2; exit 1; fi

lxc init "$tool_image" "$tool_exporter" --no-profiles --storage "$storage_pool" \
  --config user.agent-eval.managed=true --config user.agent-eval.purpose=tool-exporter
lxc start "$tool_exporter"
for attempt in $(seq 1 60); do lxc exec "$tool_exporter" -- true >/dev/null 2>&1 && break; sleep 1; done
lxc exec "$tool_exporter" -- tar --exclude=opt/agent-eval/swebench --exclude=opt/agent-eval/tool-layer.tar -cf /opt/agent-eval/tool-layer.tar /opt/agent-eval /usr/lib/node_modules /usr/bin/node /usr/bin/codex /usr/bin/claude /usr/local/bin/agent-kernel-host /usr/local/bin/agent-kernel-executor /usr/local/bin/agent-eval-runlab-driver /usr/local/bin/agent-eval-codex-app-server /usr/local/bin/agent-eval-swe-bench-grade /usr/bin/busybox
lxc file pull "$tool_exporter/opt/agent-eval/tool-layer.tar" "$staging/tool-layer.tar"
lxc file pull "$tool_exporter/usr/bin/busybox" "$staging/busybox"
lxc delete --force "$tool_exporter"
cp "$root/deploy/evaluation/install-swe-bench-tool-layer.sh" "$staging/install.sh"
jq -n --arg officialInstanceImageDigest "$official_image" --arg instanceId "$instance_id" --arg baseCommit "$base_commit" --arg harnessRevision f7bbbb2ccdf479001d6467c9e34af59e44a840f9 '{schemaVersion:1, officialInstanceImageDigest:$officialInstanceImageDigest, instanceId:$instanceId, baseCommit:$baseCommit, harnessRevision:$harnessRevision}' > "$staging/swe-bench-image.json"

"$crane_binary" export "$official_image" "$staging/rootfs.tar"
created_at=$("$crane_binary" config "$official_image" | jq -r '.created')
creation_date=$(date --date="$created_at" +%s)
if ! [[ "$creation_date" =~ ^[0-9]+$ ]]; then echo "official OCI config has no valid creation date" >&2; exit 1; fi
sed "s/__CREATION_DATE__/$creation_date/" "$root/deploy/evaluation/lxd-oci-rootfs-metadata.yaml" > "$staging/metadata.yaml"
tar -C "$staging" -cf "$staging/metadata.tar" metadata.yaml
source_fingerprint=pending
lxc image import "$staging/metadata.tar" "$staging/rootfs.tar" --alias "$source_alias"
source_fingerprint=$(lxc image list "$source_alias" --format json | jq -r '.[0].fingerprint // empty')
if [ -z "$source_fingerprint" ]; then echo "could not determine imported OCI rootfs fingerprint" >&2; exit 1; fi

lxc init "local:$source_fingerprint" "$builder" --no-profiles --storage "$storage_pool" \
  --device root,size=40GiB --device eth0,network=lxdbr0 --device eth0,ipv4.address="$builder_address" \
  --config limits.cpu=4 --config limits.memory=8GiB \
  --config raw.lxc='lxc.init.cmd=/bin/sleep infinity' \
  --config user.agent-eval.managed=true --config user.agent-eval.purpose=swe-bench-image-builder \
  --config user.agent-eval.official-oci="$official_image" --config user.agent-eval.instance-id="$instance_id"
lxc start "$builder"
ready=false
for attempt in $(seq 1 60); do
  if lxc exec "$builder" -- /bin/sh -c 'test -d /testbed/.git' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then echo "SWE-Bench LXD builder did not become ready" >&2; exit 1; fi
lxc file push "$staging/busybox" "$builder/usr/local/bin/busybox"
lxc exec "$builder" -- chmod 0755 /usr/local/bin/busybox
lxc exec "$builder" -- /usr/local/bin/busybox ip link set eth0 up
lxc exec "$builder" -- /usr/local/bin/busybox ip address add "$builder_address/24" dev eth0
lxc exec "$builder" -- /usr/local/bin/busybox ip route add default via "$builder_gateway"
lxc exec "$builder" -- sh -ceu 'if [ -L /etc/resolv.conf ]; then unlink /etc/resolv.conf; fi; printf "nameserver %s\n" "$1" > /etc/resolv.conf' dns "$builder_gateway"
lxc exec "$builder" -- mkdir -p /root/agent-eval-install
for asset in tool-layer.tar swe-bench-image.json install.sh; do
  lxc file push "$staging/$asset" "$builder/root/agent-eval-install/$asset"
done
lxc exec "$builder" -- bash /root/agent-eval-install/install.sh
lxc exec "$builder" -- /opt/miniconda3/bin/python -m venv /opt/agent-eval/swebench
lxc exec "$builder" -- /opt/agent-eval/swebench/bin/pip install --no-cache-dir git+https://github.com/SWE-bench/SWE-bench.git@f7bbbb2ccdf479001d6467c9e34af59e44a840f9
lxc exec "$builder" -- sh -ceu 'if test -d /opt/agent-eval/swebench-source/.git; then git -C /opt/agent-eval/swebench-source checkout --detach "$1"; else git clone --filter=blob:none https://github.com/SWE-bench/SWE-bench.git /opt/agent-eval/swebench-source; git -C /opt/agent-eval/swebench-source checkout --detach "$1"; fi' install-source f7bbbb2ccdf479001d6467c9e34af59e44a840f9
lxc exec "$builder" -- sh -ceu 'test "$(git -C /opt/agent-eval/swebench-source rev-parse HEAD)" = "$1"' verify-source f7bbbb2ccdf479001d6467c9e34af59e44a840f9
lxc exec "$builder" -- /opt/agent-eval/swebench/bin/python -c 'import importlib.metadata as metadata; assert metadata.version("swebench") == "4.1.0"'
lxc exec "$builder" -- install -d -m 0755 /opt/agent-eval/swebench-wheelhouse
lxc exec "$builder" -- /opt/miniconda3/envs/testbed/bin/python -m pip download --only-binary=:all: --dest /opt/agent-eval/swebench-wheelhouse \
  setuptools==68.0.0 setuptools_scm==7.1.0 wheel==0.44.0 cython==0.29.22 \
  oldest-supported-numpy==2023.12.21 extension-helpers==1.2.0
lxc exec "$builder" -- sh -ceu 'test -n "$(find /opt/agent-eval/swebench-wheelhouse -maxdepth 1 -type f -name "setuptools-68.0.0-*.whl" -print -quit)"; test -n "$(find /opt/agent-eval/swebench-wheelhouse -maxdepth 1 -type f -name "Cython-0.29.22-*.whl" -print -quit)"; test -n "$(find /opt/agent-eval/swebench-wheelhouse -maxdepth 1 -type f -name "oldest_supported_numpy-2023.12.21-*.whl" -print -quit)"'
lxc exec "$builder" -- git -C /testbed reset --hard "$base_commit"
lxc exec "$builder" -- git -C /testbed clean -fdx
lxc exec "$builder" -- sh -ceu 'test -d /testbed/.git; test "$(git -C /testbed rev-parse HEAD)" = "$1"; test -z "$(git -C /testbed status --porcelain=v1 --untracked-files=all)"' verify "$base_commit"
lxc stop --force "$builder"
lxc config device remove "$builder" eth0
lxc publish "$builder" --alias "$output_alias" \
  description="Agent Evaluation SWE-Bench trial image: $instance_id from $official_image"
lxc image info "$output_alias"
