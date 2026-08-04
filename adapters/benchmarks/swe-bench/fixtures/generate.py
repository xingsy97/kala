"""Generate immutable standalone SWE-Bench adapter inputs.

The input dataset supplies official task records. A separately reviewed lineage
manifest supplies the immutable image and repository identities required by the
standalone adapter. One canonical ``SweBenchTaskPackInput`` object is written
per line; no product Session or Host run state is read.

Example::

  python fixtures/generate.py \
    --output /tmp/swe-bench-inputs.jsonl \
    --lineage-manifest /tmp/swe-bench-lineage.json \
    --harness-revision f7bbbb2ccdf479001d6467c9e34af59e44a840f9

The lineage manifest is an object keyed by ``instance_id``. Each value contains
``officialInstanceImageDigest``, ``trialSandboxImageDigest``, and
``repositoryManifestHash``. Missing lineage is rejected instead of falling back
to a mutable tag.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from types import SimpleNamespace
from typing import Any, Mapping


DEFAULT_DATASET = "princeton-nlp/SWE-bench_Verified"
DEFAULT_HARNESS_REVISION = "f7bbbb2ccdf479001d6467c9e34af59e44a840f9"


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _lineage_for(
    instance_id: str, lineage_manifest: Mapping[str, Any]
) -> Mapping[str, Any]:
    lineage = lineage_manifest.get(instance_id)
    if not isinstance(lineage, Mapping):
        raise ValueError(f"lineage manifest has no entry for {instance_id}")
    for field in (
        "officialInstanceImageDigest",
        "trialSandboxImageDigest",
        "repositoryManifestHash",
    ):
        _required_string(lineage.get(field), f"{instance_id}.{field}")
    repository_hash = str(lineage["repositoryManifestHash"])
    if len(repository_hash) != 64 or any(
        character not in "0123456789abcdef" for character in repository_hash
    ):
        raise ValueError(f"{instance_id}.repositoryManifestHash must be SHA-256")
    return lineage


def build_task_pack_input(
    row: Mapping[str, Any],
    lineage_manifest: Mapping[str, Any],
    options: SimpleNamespace,
) -> dict[str, Any]:
    instance_id = _required_string(row.get("instance_id"), "instance_id")
    lineage = _lineage_for(instance_id, lineage_manifest)
    required_record_fields = (
        "repo",
        "base_commit",
        "problem_statement",
        "version",
        "FAIL_TO_PASS",
        "PASS_TO_PASS",
        "test_patch",
    )
    official_record = dict(row)
    for field in required_record_fields:
        value = official_record.get(field)
        if field in ("FAIL_TO_PASS", "PASS_TO_PASS") and isinstance(value, list):
            official_record[field] = json.dumps(value, separators=(",", ":"))
            value = official_record[field]
        _required_string(value, f"{instance_id}.{field}")

    return {
        "schemaVersion": 1,
        "datasetId": options.dataset_id,
        "datasetVersion": options.dataset_version,
        "split": options.split,
        "harnessRevision": options.harness_revision,
        "officialInstanceImageDigest": lineage["officialInstanceImageDigest"],
        "trialSandboxImageDigest": lineage["trialSandboxImageDigest"],
        "repositoryManifestHash": lineage["repositoryManifestHash"],
        "officialRecord": official_record,
        "license": options.license,
        "evaluationPermission": options.evaluation_permission,
        "testTimeoutSeconds": options.test_timeout_seconds,
        "namespace": options.namespace,
    }


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--lineage-manifest", required=True)
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--dataset-id", default="swe-bench-verified")
    parser.add_argument("--dataset-version", default="verified-v1")
    parser.add_argument("--split", default="test")
    parser.add_argument(
        "--harness-revision", default=DEFAULT_HARNESS_REVISION
    )
    parser.add_argument("--license", default="MIT")
    parser.add_argument(
        "--evaluation-permission", default="SWE-Bench benchmark evaluation"
    )
    parser.add_argument("--test-timeout-seconds", type=int, default=1800)
    parser.add_argument("--namespace", default="swebench")
    parser.add_argument("--limit", type=int, default=0)
    return parser.parse_args()


def main() -> int:
    options = _arguments()
    with open(options.lineage_manifest, encoding="utf-8") as stream:
        lineage_manifest = json.load(stream)
    if not isinstance(lineage_manifest, dict):
        raise ValueError("lineage manifest must be an object keyed by instance_id")

    from datasets import load_dataset  # type: ignore

    rows = load_dataset(options.dataset, split=options.split)
    output_directory = os.path.dirname(options.output)
    if output_directory:
        os.makedirs(output_directory, exist_ok=True)
    written = 0
    with open(options.output, "w", encoding="utf-8") as stream:
        for row in rows:
            if options.limit > 0 and written >= options.limit:
                break
            task_input = build_task_pack_input(dict(row), lineage_manifest, options)
            stream.write(json.dumps(task_input, separators=(",", ":")) + "\n")
            written += 1
    print(f"wrote {written} canonical task inputs to {options.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
