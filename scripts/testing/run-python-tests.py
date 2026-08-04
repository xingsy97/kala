#!/usr/bin/env python3
"""Minimal runner for repository-local function tests; external pytest suites stay opt-in."""

import importlib.util
import inspect
import tempfile
import traceback
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
TEST_ROOT = ROOT / "tests" / "python"
failures = 0
count = 0

for test_file in sorted(TEST_ROOT.glob("test_*.py")):
    spec = importlib.util.spec_from_file_location(test_file.stem, test_file)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {test_file}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name, function in inspect.getmembers(module, inspect.isfunction):
        if not name.startswith("test_"):
            continue
        count += 1
        try:
            parameters = inspect.signature(function).parameters
            unknown = set(parameters) - {"tmp_path"}
            if unknown:
                raise RuntimeError(f"unsupported fixtures: {', '.join(sorted(unknown))}")
            if "tmp_path" in parameters:
                with tempfile.TemporaryDirectory(prefix="agent-kernel-test-") as directory:
                    function(tmp_path=Path(directory))
            else:
                function()
            print(f"PASS {test_file.name}::{name}")
        except Exception:
            failures += 1
            print(f"FAIL {test_file.name}::{name}")
            traceback.print_exc()

print(f"Python tests: {count - failures} passed, {failures} failed, {count} total")
raise SystemExit(1 if failures else 0)
