#!/usr/bin/env bash
set -euo pipefail
tar -xf /root/agent-eval-install/tool-layer.tar -C /
install -d -m 0755 /etc/agent-eval
install -m 0444 /root/agent-eval-install/swe-bench-image.json /etc/agent-eval/swe-bench-image.json
printf '%s\n' '{"type":"module"}' > /opt/agent-eval/package.json
chmod 0444 /opt/agent-eval/package.json
node --version
codex --version
claude --version
agent-kernel-host --version
agent-kernel-executor --version
agent-eval-runlab-driver --version
printf '%s\n' '#!/bin/sh' 'PATH=/opt/agent-eval/swebench/bin:$PATH PYTHONPATH=/opt/agent-eval/swebench-source${PYTHONPATH:+:$PYTHONPATH} PIP_NO_INDEX=1 PIP_FIND_LINKS=/opt/agent-eval/swebench-wheelhouse exec node /opt/agent-eval/bin/agent-eval-swe-bench-grade.js "$@"' > /usr/local/bin/agent-eval-swe-bench-grade
chmod 0755 /usr/local/bin/agent-eval-swe-bench-grade
rm -rf /root/agent-eval-install
