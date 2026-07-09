from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from .sample_builder import build_sample_from_artifacts


async def generate(args: Any, sample: Any, sampling_params: dict[str, Any]) -> Any:
    """Build a slime-compatible sample from agent-kernel rollout artifacts.

    Live mode calls `agent-kernel-host rl run-rollout-smoke` for the task file
    supplied by slime metadata/args, then converts the produced trajectory and
    reward artifacts into the sample fields slime consumes. Dry-run mode can
    still pass trajectory/reward artifact paths directly.
    """

    metadata = _metadata(sample)
    live = bool(metadata.get("agent_kernel_task_file") or getattr(args, "agent_kernel_task_file", None))
    if live:
        metadata = {**metadata, **await _run_live_rollout(args, metadata, sampling_params)}

    trajectory_path = metadata.get("trajectory_path") or getattr(args, "agent_kernel_trajectory", None)
    reward_path = metadata.get("reward_path") or getattr(args, "agent_kernel_reward", None)
    if not trajectory_path or not reward_path:
        raise ValueError("agent-kernel slime generate requires trajectory_path/reward_path or agent_kernel_task_file")

    built = build_sample_from_artifacts(
        trajectory_path=Path(trajectory_path),
        reward_path=Path(reward_path),
        require_logprobs=bool(metadata.get("require_logprobs", True)),
    )
    return _apply_sample(sample, built)


async def _run_live_rollout(args: Any, metadata: dict[str, Any], sampling_params: dict[str, Any]) -> dict[str, Any]:
    task_file = metadata.get("agent_kernel_task_file") or getattr(args, "agent_kernel_task_file", None)
    root_dir = metadata.get("agent_kernel_root_dir") or getattr(args, "agent_kernel_root_dir", None)
    if not task_file or not root_dir:
        raise ValueError("live agent-kernel rollout requires agent_kernel_task_file and agent_kernel_root_dir")
    cli = metadata.get("agent_kernel_cli") or getattr(args, "agent_kernel_cli", "agent-kernel-host")
    rollout_id = metadata.get("rollout_id") or metadata.get("agent_kernel_rollout_id") or getattr(args, "agent_kernel_rollout_id", None)
    cmd = [
        str(cli),
        "rl",
        "run-rollout-smoke",
        "--root-dir",
        str(root_dir),
        "--task-file",
        str(task_file),
        "--model",
        str(metadata.get("model") or getattr(args, "agent_kernel_model", getattr(args, "hf_checkpoint", "policy-model"))),
        "--require-logprobs",
    ]
    if rollout_id:
        cmd.extend(["--rollout-id", str(rollout_id)])
    task_id = metadata.get("task_id") or metadata.get("agent_kernel_task_id") or getattr(args, "agent_kernel_task_id", None)
    if task_id:
        cmd.extend(["--task-id", str(task_id)])
    policy_base_url = metadata.get("policy_base_url") or getattr(args, "agent_kernel_policy_base_url", None)
    if not policy_base_url:
        try:
            from slime.rollout.sglang_rollout import get_model_url

            policy_base_url = get_model_url(args, "default", "")
        except Exception:
            policy_base_url = None
    if policy_base_url:
        cmd.extend(["--policy-base-url", str(policy_base_url)])
    tokenizer = metadata.get("tokenizer") or metadata.get("agent_kernel_tokenizer") or getattr(args, "agent_kernel_tokenizer", None)
    if tokenizer:
        cmd.extend(["--tokenizer", str(tokenizer)])
    if metadata.get("fixture_policy") or getattr(args, "agent_kernel_fixture_policy", False):
        cmd.append("--fixture-policy")
    timeout_ms = metadata.get("timeout_ms") or sampling_params.get("timeout_ms") or getattr(args, "agent_kernel_timeout_ms", None)
    if timeout_ms:
        cmd.extend(["--timeout-ms", str(timeout_ms)])
    max_new_tokens = (
        metadata.get("max_new_tokens")
        or metadata.get("agent_kernel_max_new_tokens")
        or sampling_params.get("max_new_tokens")
        or getattr(args, "agent_kernel_max_new_tokens", None)
    )
    if max_new_tokens:
        cmd.extend(["--max-new-tokens", str(max_new_tokens)])

    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"agent-kernel rollout failed with code {proc.returncode}: {stderr.decode('utf-8', 'replace')[:1000]} {stdout.decode('utf-8', 'replace')[:1000]}")
    payload = json.loads(stdout.decode("utf-8"))
    result = payload.get("result") or {}
    if result.get("readiness") != "slime-sample-ready":
        raise RuntimeError(f"agent-kernel rollout is not slime-sample-ready: {json.dumps(result, ensure_ascii=False)[:1000]}")
    trajectory_ref = result.get("trajectoryRef") or {}
    reward_ref = result.get("rewardRef") or {}
    if not trajectory_ref.get("uri") or not reward_ref.get("uri"):
        raise RuntimeError("agent-kernel rollout did not produce trajectoryRef and rewardRef")
    root = Path(root_dir)
    return {
        "trajectory_path": str(root / trajectory_ref["uri"]),
        "reward_path": str(root / reward_ref["uri"]),
        "require_logprobs": True,
    }


def _metadata(sample: Any) -> dict[str, Any]:
    value = getattr(sample, "metadata", None)
    if isinstance(value, dict):
        return value
    if isinstance(sample, dict) and isinstance(sample.get("metadata"), dict):
        return sample["metadata"]
    return {}


def _apply_sample(sample: Any, built: dict[str, Any]) -> Any:
    if isinstance(sample, dict):
        out = dict(sample)
        out.update(built)
        return out
    for key, value in built.items():
        if key == "status":
            status_type = type(getattr(sample, "status", None))
            try:
                value = status_type(value)
            except Exception:
                pass
        setattr(sample, key, value)
    return sample
