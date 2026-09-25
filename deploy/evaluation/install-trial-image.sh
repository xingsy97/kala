#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
extra_packages=
if [ -n "${AGENT_EVAL_SWEBENCH_OFFICIAL_IMAGE:-}" ]; then extra_packages='systemd-sysv dbus'; fi
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git jq python3 python3-pip python3-venv build-essential ripgrep patch bubblewrap $extra_packages
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y --no-install-recommends nodejs=22.23.2-1nodesource1
npm install --global --ignore-scripts @openai/codex@0.146.0 @anthropic-ai/claude-code@2.1.83
npm install --prefix /opt/agent-eval --ignore-scripts jsonc-parser@3.3.1

python3 -m venv /opt/agent-eval/swebench
git clone --filter=blob:none --no-checkout https://github.com/SWE-bench/SWE-bench.git /opt/agent-eval/swebench-source
git -C /opt/agent-eval/swebench-source fetch --depth 1 origin f7bbbb2ccdf479001d6467c9e34af59e44a840f9
git -C /opt/agent-eval/swebench-source checkout --detach f7bbbb2ccdf479001d6467c9e34af59e44a840f9
test "$(git -C /opt/agent-eval/swebench-source rev-parse HEAD)" = f7bbbb2ccdf479001d6467c9e34af59e44a840f9
/opt/agent-eval/swebench/bin/pip install --no-cache-dir -e /opt/agent-eval/swebench-source

install -d -m 0755 /opt/agent-eval/bin
install -m 0755 /root/agent-eval-install/agent-kernel-host.cjs /opt/agent-eval/bin/agent-kernel-host.cjs
install -m 0755 /root/agent-eval-install/kala-executor.cjs /opt/agent-eval/bin/kala-executor.cjs
install -m 0755 /root/agent-eval-install/agent-eval-runlab-driver.cjs /opt/agent-eval/bin/agent-eval-runlab-driver.cjs
install -m 0755 /root/agent-eval-install/agent-eval-codex-app-server.js /opt/agent-eval/bin/agent-eval-codex-app-server.js
install -m 0755 /root/agent-eval-install/agent-eval-swe-bench-grade.js /opt/agent-eval/bin/agent-eval-swe-bench-grade.js
printf '%s\n' '{"type":"module"}' > /opt/agent-eval/package.json
chmod 0444 /opt/agent-eval/package.json

printf '%s\n' '#!/bin/sh' 'exec node /opt/agent-eval/bin/agent-kernel-host.cjs "$@"' > /usr/local/bin/agent-kernel-host
printf '%s\n' '#!/bin/sh' 'exec node /opt/agent-eval/bin/kala-executor.cjs "$@"' > /usr/local/bin/agent-kernel-executor
printf '%s\n' '#!/bin/sh' 'exec node /opt/agent-eval/bin/agent-eval-runlab-driver.cjs "$@"' > /usr/local/bin/agent-eval-runlab-driver
printf '%s\n' '#!/bin/sh' 'exec node /opt/agent-eval/bin/agent-eval-codex-app-server.js "$@"' > /usr/local/bin/agent-eval-codex-app-server
printf '%s\n' '#!/bin/sh' 'PATH=/opt/agent-eval/swebench/bin:$PATH PYTHONPATH=/opt/agent-eval/swebench-source${PYTHONPATH:+:$PYTHONPATH} exec node /opt/agent-eval/bin/agent-eval-swe-bench-grade.js "$@"' > /usr/local/bin/agent-eval-swe-bench-grade
chmod 0755 /usr/local/bin/agent-kernel-host /usr/local/bin/agent-kernel-executor /usr/local/bin/agent-eval-runlab-driver /usr/local/bin/agent-eval-codex-app-server /usr/local/bin/agent-eval-swe-bench-grade

node --version
codex --version
claude --version
agent-kernel-host --version
agent-kernel-executor --version
agent-eval-runlab-driver --version
if [ -n "${AGENT_EVAL_SWEBENCH_OFFICIAL_IMAGE:-}" ]; then
  install -d -m 0755 /etc/agent-eval
  jq -n \
    --arg officialInstanceImageDigest "$AGENT_EVAL_SWEBENCH_OFFICIAL_IMAGE" \
    --arg instanceId "$AGENT_EVAL_SWEBENCH_INSTANCE_ID" \
    --arg baseCommit "$AGENT_EVAL_SWEBENCH_BASE_COMMIT" \
    --arg harnessRevision "$AGENT_EVAL_SWEBENCH_HARNESS_REVISION" \
    '{schemaVersion:1, officialInstanceImageDigest:$officialInstanceImageDigest, instanceId:$instanceId, baseCommit:$baseCommit, harnessRevision:$harnessRevision}' \
    > /etc/agent-eval/swe-bench-image.json
  chmod 0444 /etc/agent-eval/swe-bench-image.json
fi
rm -rf /var/lib/apt/lists/* /root/.cache /root/agent-eval-install
