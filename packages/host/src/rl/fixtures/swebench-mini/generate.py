"""Generate SWE-Bench Verified Mini task fixtures for Run 2-B.

Reads MariusHobbhahn/swe-bench-verified-mini from HuggingFace, converts each
row into an AgentRlTask (workspace.kind='git' + verifier.kind='swebench'), and
writes one JSON per line to `<output>`.

Usage:
  python generate.py --output /workspace/agent-kernel-runs/task-fixtures/swebench-mini/prompt-data.jsonl
  python generate.py --output /tmp/pool.jsonl --limit 5

No Docker / swebench harness required at generation time (metadata only).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


PROMPT_TEMPLATE = (
    "You are working in a git repository. Your task:\n\n"
    "{problem}\n\n"
    "You may only modify source files. Tests are pinned and must not be modified.\n"
    "Use tools: read, ls, glob, grep, write, edit, bash.\n"
    "When you believe your fix is complete, run the test suite with bash."
)


def _to_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
        except json.JSONDecodeError:
            return [s]
        return _to_list(parsed)
    return [str(value)]


def _build_task(row: dict[str, Any]) -> dict[str, Any]:
    instance_id = row["instance_id"]
    repo = row["repo"]
    return {
        "schemaVersion": "agent.rl.task.v1",
        "taskId": f"swebench-{instance_id}",
        "source": {"kind": "swebench", "sourceId": instance_id},
        "prompt": PROMPT_TEMPLATE.format(problem=row["problem_statement"]),
        "workspace": {
            "kind": "git",
            "repoUrl": f"https://github.com/{repo}.git",
            "baseCommit": row["base_commit"],
        },
        "verifier": {
            "kind": "swebench",
            "timeoutMs": 600_000,
        },
        "governance": {
            "trainingAllowed": True,
            "redactionStatus": "not_required",
            "retentionClass": "training_allowed",
        },
        "metadata": {
            "instanceId": instance_id,
            "repo": repo,
            "failToPass": _to_list(row.get("FAIL_TO_PASS")),
            "passToPass": _to_list(row.get("PASS_TO_PASS")),
            "testPatch": row.get("test_patch", ""),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="Output JSONL path")
    parser.add_argument("--limit", type=int, default=0, help="Only emit first N rows (0=all)")
    parser.add_argument("--dataset", default="MariusHobbhahn/swe-bench-verified-mini")
    parser.add_argument("--split", default="test")
    args = parser.parse_args()

    from datasets import load_dataset  # type: ignore

    ds = load_dataset(args.dataset, split=args.split)
    rows = list(ds)
    if args.limit > 0:
        rows = rows[: args.limit]

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    written = 0
    with open(args.output, "w", encoding="utf-8") as fh:
        for row in rows:
            task = _build_task(dict(row))
            fh.write(json.dumps(task) + "\n")
            written += 1

    print(f"wrote {written} tasks to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
