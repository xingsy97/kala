"""Generate MBPP-Plus task fixtures for Run 2-A.

Reads evalplus.data.get_mbpp_plus(), filters to short & import-free tasks,
executes canonical solutions to compute expected outputs, then writes:

  <out>/tarballs/<task_id>.tar.gz   (flat: src/solution.py + tests/test_solution.py + pytest.ini)
  <out>/prompt-data.jsonl           (one AgentRlTask per line, referencing above tarballs)

Usage:
  python generate.py --out /workspace/agent-kernel-runs/task-fixtures --count 30

Environment: run via the venv at packages/host/src/rl/fixtures/mbpp-plus/.venv
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any


BASE_PROMPT = (
    "Implement the function `{entry_point}` in src/solution.py so that all tests in tests/ pass.\n\n"
    "Task description:\n{description}\n\n"
    "Rules:\n"
    "- Only modify files under src/.\n"
    "- Do not modify anything under tests/ or pytest.ini.\n"
    "- Run `pytest -q` to check your work.\n"
)


VERIFIER_CMD = (
    "pytest --tb=no -q --json-report --json-report-file=/tmp/pytest-report.json 2>&1 || true; "
    "python3 -c 'import json,sys;"
    "r=json.load(open(\"/tmp/pytest-report.json\"));"
    "s=r[\"summary\"];"
    "t=s.get(\"total\",0);"
    "p=s.get(\"passed\",0);"
    "print(\"REWARD_PASS_RATE=\"+(str(p/t) if t else \"0.0\"));"
    "sys.exit(0 if t and p==t else 1)'"
)


def _extract_description(prompt: str) -> str:
    body = prompt.strip()
    if body.startswith('"""') and body.endswith('"""'):
        body = body[3:-3].strip()
    lines = []
    for line in body.split("\n"):
        if line.strip().startswith("assert "):
            break
        lines.append(line)
    return "\n".join(lines).strip()


def _canonical_has_imports(canonical_solution: str) -> bool:
    for line in canonical_solution.split("\n"):
        s = line.strip()
        if s.startswith("import ") or s.startswith("from "):
            return True
    return False


def _canonical_line_count(canonical_solution: str) -> int:
    return sum(
        1
        for line in canonical_solution.split("\n")
        if line.strip() and not line.strip().startswith("#")
    )


def _compute_expected(task: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Run canonical solution in subprocess (deterministic hash seed), return outputs as Python repr strings.

    Returns (base_reprs, plus_reprs) — each element is the repr() of the expected output for that input,
    suitable for direct embedding into a test assertion. Raises ValueError if the canonical solution
    is non-deterministic across PYTHONHASHSEED values.
    """
    script = (
        "import json, sys\n"
        f"exec({task['canonical_solution']!r}, globals())\n"
        f"fn = globals()[{task['entry_point']!r}]\n"
        f"base = {task['base_input']!r}\n"
        f"plus = {task['plus_input']!r}\n"
        "out_base = [repr(fn(*inp)) for inp in base]\n"
        "out_plus = [repr(fn(*inp)) for inp in plus]\n"
        "json.dump({'base': out_base, 'plus': out_plus}, sys.stdout)\n"
    )
    outputs: list[str] = []
    for seed in ("0", "1"):
        env = {**os.environ, "PYTHONHASHSEED": seed}
        result = subprocess.run(
            [sys.executable, "-c", script],
            check=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=15,
        )
        outputs.append(result.stdout)
    if outputs[0] != outputs[1]:
        raise ValueError("canonical solution output varies across PYTHONHASHSEED")
    payload = json.loads(outputs[0])
    return payload["base"], payload["plus"]


def _make_test_file(entry_point: str, inputs: list[Any], output_reprs: list[str], atol: float) -> str:
    lines = [
        "import math",
        "from solution import " + entry_point,
        "",
        "",
    ]
    for i, (inp, out_repr) in enumerate(zip(inputs, output_reprs)):
        args = ", ".join(repr(x) for x in inp)
        lines.append(f"def test_case_{i:03d}():")
        lines.append(f"    actual = {entry_point}({args})")
        if atol:
            lines.append(f"    expected = {out_repr}")
            lines.append(f"    if isinstance(expected, float):")
            lines.append(f"        assert math.isclose(actual, expected, abs_tol={atol!r})")
            lines.append(f"    else:")
            lines.append(f"        assert actual == expected")
        else:
            lines.append(f"    assert actual == {out_repr}")
        lines.append("")
    return "\n".join(lines)


def _make_stub(entry_point: str, description: str) -> str:
    return (
        f'"""Implement {entry_point} to satisfy the tests in tests/.\n\n'
        f'{description}\n'
        f'"""\n\n\n'
        f'def {entry_point}(*args, **kwargs):\n'
        f'    raise NotImplementedError\n'
    )


def _write_task_tarball(
    out_tarballs: Path,
    task_slug: str,
    entry_point: str,
    stub_src: str,
    test_src: str,
) -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "src").mkdir()
        (root / "tests").mkdir()
        (root / "src" / "solution.py").write_text(stub_src)
        (root / "tests" / "test_solution.py").write_text(test_src)
        (root / "pytest.ini").write_text("[pytest]\ntestpaths = tests\npythonpath = src\n")
        tarball_path = out_tarballs / f"{task_slug}.tar.gz"
        with tarfile.open(tarball_path, "w:gz") as tar:
            for entry in sorted(root.iterdir()):
                tar.add(entry, arcname=entry.name)
    return tarball_path


def _build_task_record(
    task_slug: str,
    entry_point: str,
    description: str,
    archive_ref: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": "agent.rl.task.v1",
        "taskId": task_slug,
        "source": {"kind": "local-fixture"},
        "prompt": BASE_PROMPT.format(entry_point=entry_point, description=description),
        "workspace": {"kind": "archive", "archiveRef": archive_ref},
        "verifier": {
            "kind": "command",
            "command": ["bash", "-lc", VERIFIER_CMD],
            "timeoutMs": 60000,
            "rewardParsePattern": "REWARD_PASS_RATE=([0-9.]+)",
            "writeScope": {
                "allowGlobs": ["src/**"],
                "denyGlobs": ["tests/**", "pytest.ini"],
            },
        },
        "governance": {
            "trainingAllowed": True,
            "redactionStatus": "not_required",
            "retentionClass": "training_allowed",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="Output directory root (tarballs/ + prompt-data.jsonl)")
    parser.add_argument("--count", type=int, default=30, help="Max number of tasks to emit")
    parser.add_argument("--max-canonical-lines", type=int, default=6)
    parser.add_argument(
        "--archive-ref-prefix",
        default="file:///workspace/agent-kernel-runs/task-fixtures/tarballs",
        help="URI prefix that will be joined with '<task_slug>.tar.gz' when producing task records",
    )
    args = parser.parse_args()

    try:
        from evalplus.data import get_mbpp_plus
    except ImportError:
        print("ERROR: evalplus not installed. Use the venv at packages/host/src/rl/fixtures/mbpp-plus/.venv", file=sys.stderr)
        return 2

    out_root = Path(args.out)
    out_tarballs = out_root / "tarballs"
    out_tarballs.mkdir(parents=True, exist_ok=True)

    dataset = get_mbpp_plus()
    print(f"loaded {len(dataset)} MBPP+ tasks")

    records: list[dict[str, Any]] = []
    skipped = {"has_imports": 0, "too_long": 0, "exec_error": 0, "no_inputs": 0}

    for task_id, task in dataset.items():
        if len(records) >= args.count:
            break
        canonical = task["canonical_solution"]
        if _canonical_has_imports(canonical):
            skipped["has_imports"] += 1
            continue
        if _canonical_line_count(canonical) > args.max_canonical_lines:
            skipped["too_long"] += 1
            continue
        if not task["base_input"] and not task["plus_input"]:
            skipped["no_inputs"] += 1
            continue
        try:
            base_out, plus_out = _compute_expected(task)
        except subprocess.CalledProcessError as exc:
            skipped["exec_error"] += 1
            print(f"  skip {task_id}: canonical subprocess failed (stderr={exc.stderr[:120]!r})")
            continue
        except Exception as exc:
            skipped["exec_error"] += 1
            print(f"  skip {task_id}: {exc}")
            continue

        entry_point = task["entry_point"]
        description = _extract_description(task["prompt"])
        inputs = list(task["base_input"]) + list(task["plus_input"])
        output_reprs = base_out + plus_out
        try:
            test_src = _make_test_file(entry_point, inputs, output_reprs, task.get("atol", 0) or 0)
        except Exception as exc:
            skipped["exec_error"] += 1
            print(f"  skip {task_id}: test render failed {exc!r}")
            continue
        stub_src = _make_stub(entry_point, description)

        task_slug = task_id.replace("/", "-").lower()
        _write_task_tarball(out_tarballs, task_slug, entry_point, stub_src, test_src)
        archive_ref = f"{args.archive_ref_prefix.rstrip('/')}/{task_slug}.tar.gz"
        records.append(_build_task_record(task_slug, entry_point, description, archive_ref))
        print(f"  wrote {task_slug} ({len(inputs)} tests)")

    jsonl_path = out_root / "prompt-data.jsonl"
    with jsonl_path.open("w") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")

    print(f"\nemitted {len(records)} tasks -> {jsonl_path}")
    print(f"tarballs in {out_tarballs}")
    print(f"skipped: {skipped}")
    return 0 if records else 1


if __name__ == "__main__":
    sys.exit(main())
