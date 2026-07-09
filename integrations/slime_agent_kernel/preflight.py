from __future__ import annotations

import argparse
import importlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_IMPORTS = (
    "torch",
    "numpy",
    "ray",
    "slime",
    "megatron",
    "mbridge",
    "sglang",
    "sglang_router",
    "transformer_engine",
    "apex",
    "flash_attn_2_cuda",
)


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        value: dict[str, Any] = {"name": self.name, "ok": self.ok, "detail": self.detail}
        if self.metadata:
            value["metadata"] = self.metadata
        return value


def run_preflight(slime_root: str | Path, *, import_modules: tuple[str, ...] = DEFAULT_IMPORTS) -> dict[str, Any]:
    root = Path(slime_root)
    checks: list[Check] = []
    checks.extend(check_imports(import_modules))
    checks.extend(check_slime_source_contract(root))
    ok = all(check.ok for check in checks)
    return {
        "schemaVersion": "agent.slime_trainer_preflight.v1",
        "ok": ok,
        "slimeRoot": str(root),
        "checks": [check.to_json() for check in checks],
        "decision": decision_text(checks),
    }


def check_imports(modules: tuple[str, ...]) -> list[Check]:
    checks: list[Check] = []
    for name in modules:
        try:
            module = importlib.import_module(name)
        except Exception as exc:
            checks.append(Check(name=f"import:{name}", ok=False, detail=f"{type(exc).__name__}: {exc}"))
            continue
        version = getattr(module, "__version__", None)
        checks.append(
            Check(
                name=f"import:{name}",
                ok=True,
                detail="import ok" if version is None else f"import ok, version {version}",
                metadata={"version": version} if version is not None else {},
            )
        )
    return checks


def check_slime_source_contract(root: Path) -> list[Check]:
    checks: list[Check] = []
    checks.append(check_contains(root / "slime/backends/megatron_utils/data.py", "qkv_format=\"thd\"", "slime data path builds PackedSeqParams with qkv_format=thd"))
    checks.append(check_contains(root / "slime/backends/megatron_utils/data.py", "PackedSeqParams", "slime data path imports/uses PackedSeqParams"))
    checks.append(check_contains(root / "tests/test_qwen2.5_0.5B_short.py", "--ref-load /root/models/{MODEL_NAME}/", "Qwen2.5-0.5B short test uses HF directory as --ref-load"))
    checks.append(check_contains(root / "tests/test_qwen2.5_0.5B_short.py", "--megatron-to-hf-mode bridge", "Qwen2.5-0.5B short test uses bridge mode"))
    checks.append(check_contains(root / "tests/test_qwen2.5_0.5B_short.py", "--attention-backend flash", "Qwen2.5-0.5B short test requests flash attention backend"))
    checks.append(check_contains(root / "scripts/models/qwen2.5-0.5B.sh", "--num-layers 24", "Qwen2.5-0.5B Megatron model args are present"))
    checks.append(check_contains(root / "scripts/models/qwen2.5-0.5B.sh", "--num-query-groups 2", "Qwen2.5-0.5B GQA args are present"))
    return checks


def check_contains(path: Path, needle: str, detail: str) -> Check:
    if not path.exists():
        return Check(name=f"source:{path.name}:{needle}", ok=False, detail=f"missing file: {path}")
    text = path.read_text(encoding="utf-8")
    return Check(
        name=f"source:{path.name}:{needle}",
        ok=needle in text,
        detail=detail if needle in text else f"missing expected text in {path}: {needle}",
        metadata={"path": str(path)},
    )


def decision_text(checks: list[Check]) -> str:
    failed = [check.name for check in checks if not check.ok]
    if not failed:
        return "pass: trainer environment and local slime source contracts are ready for the Qwen2.5-0.5B HF --ref-load smoke."
    if "import:flash_attn_2_cuda" in failed:
        return "blocked: flash_attn_2_cuda is missing; do not start a paid full trainer run because slime uses THD/data-packing attention."
    return f"blocked: preflight failed checks: {', '.join(failed)}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate a slime trainer environment before running agent-kernel E2E training.")
    parser.add_argument("--slime-root", default="references/slime", help="Path to the slime checkout to inspect.")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero when any preflight check fails.")
    args = parser.parse_args(argv)
    result = run_preflight(args.slime_root)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] or not args.strict else 20


if __name__ == "__main__":
    raise SystemExit(main())
