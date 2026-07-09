from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def build_sample_from_artifacts(
    *,
    trajectory_path: str | Path,
    reward_path: str | Path,
    require_logprobs: bool = True,
) -> dict[str, Any]:
    trajectory = _load_json(trajectory_path)
    reward = _load_json(reward_path)
    root = Path(trajectory_path).resolve().parent.parent
    captures = [_load_json(_resolve_ref(root, turn["tokenCaptureRef"]["uri"])) for turn in trajectory["turns"]]

    prompt_tokens: list[int] = []
    response_tokens: list[int] = []
    loss_mask: list[int] = []
    rollout_log_probs: list[float] = []
    for capture in captures:
        _validate_capture(capture, require_logprobs=require_logprobs)
        prompt_tokens.extend(capture["promptIds"])
        response_tokens.extend(capture["outputIds"])
        loss_mask.extend(capture["responseMask"])
        rollout_log_probs.extend(capture.get("outputLogProbs", []))

    if not response_tokens:
        raise ValueError("slime sample requires non-empty response tokens")
    if len(loss_mask) != len(response_tokens):
        raise ValueError("loss_mask length does not match response_length")
    if require_logprobs and len(rollout_log_probs) != len(response_tokens):
        raise ValueError("rollout_log_probs length does not match response_length")
    if not any(loss_mask):
        raise ValueError("slime sample requires at least one trainable token")

    tokens = [*prompt_tokens, *response_tokens]
    return {
        "tokens": tokens,
        "response_length": len(response_tokens),
        "loss_mask": loss_mask,
        "rollout_log_probs": rollout_log_probs if rollout_log_probs else None,
        "reward": reward["reward"],
        "status": "completed",
        "metadata": {
            "rollout_id": trajectory["rolloutId"],
            "task_id": trajectory["taskId"],
            "agent_kernel_session_id": trajectory["sessionId"],
            "agent_kernel_artifacts": {
                "trajectory": str(trajectory_path),
                "reward": str(reward_path),
                "token_captures": [turn["tokenCaptureRef"]["uri"] for turn in trajectory["turns"]],
            },
        },
    }


def _load_json(path: str | Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"JSON artifact must be an object: {path}")
    return value


def _resolve_ref(root: Path, uri: str) -> Path:
    path = Path(uri)
    return path if path.is_absolute() else root / uri


def _validate_capture(capture: dict[str, Any], *, require_logprobs: bool) -> None:
    if capture.get("schemaVersion") != "agent.policy_token_capture.v1":
        raise ValueError("invalid token capture schemaVersion")
    prompt_ids = capture.get("promptIds")
    output_ids = capture.get("outputIds")
    mask = capture.get("responseMask")
    logprobs = capture.get("outputLogProbs")
    if not isinstance(prompt_ids, list) or not prompt_ids:
        raise ValueError("promptIds must be non-empty")
    if not isinstance(output_ids, list) or not output_ids:
        raise ValueError("outputIds must be non-empty")
    if not isinstance(mask, list) or len(mask) != len(output_ids):
        raise ValueError("responseMask length does not match outputIds")
    if require_logprobs and (not isinstance(logprobs, list) or len(logprobs) != len(output_ids)):
        raise ValueError("outputLogProbs are required and must align with outputIds")
