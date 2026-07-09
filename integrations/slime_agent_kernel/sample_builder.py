from __future__ import annotations

import json
from pathlib import Path
from typing import Any


DEFAULT_FORK_THRESHOLD_TOKENS = 1024


def build_sample_from_artifacts(
    *,
    trajectory_path: str | Path,
    reward_path: str | Path,
    require_logprobs: bool = True,
) -> dict[str, Any]:
    samples = build_samples_from_artifacts(
        trajectory_path=trajectory_path,
        reward_path=reward_path,
        require_logprobs=require_logprobs,
    )
    if not samples:
        raise ValueError("slime sample requires at least one trainable segment")
    return samples[0]


def build_samples_from_artifacts(
    *,
    trajectory_path: str | Path,
    reward_path: str | Path,
    require_logprobs: bool = True,
    fork_threshold_tokens: int = DEFAULT_FORK_THRESHOLD_TOKENS,
) -> list[dict[str, Any]]:
    trajectory = _load_json(trajectory_path)
    reward = _load_json(reward_path)
    root = Path(trajectory_path).resolve().parent.parent
    captures = [_load_json(_resolve_ref(root, turn["tokenCaptureRef"]["uri"])) for turn in trajectory["turns"]]

    builders: list[_TrajectorySampleBuilder] = []
    current = _TrajectorySampleBuilder(fork_threshold_tokens=fork_threshold_tokens)
    for index, capture in enumerate(captures):
        _validate_capture(capture, require_logprobs=require_logprobs)
        if current.can_append(capture):
            current.append(capture)
            continue
        if current.has_trainable_response():
            builders.append(current)
        current = _TrajectorySampleBuilder(fork_threshold_tokens=fork_threshold_tokens)
        current.append(capture)
        current.metadata["forked_from_turn_index"] = index
    if current.has_trainable_response():
        builders.append(current)

    samples = [
        builder.to_sample(
            reward=reward,
            trajectory=trajectory,
            trajectory_path=trajectory_path,
            reward_path=reward_path,
            token_capture_refs=[turn["tokenCaptureRef"]["uri"] for turn in trajectory["turns"]],
            fork_index=index,
            fork_count=len(builders),
        )
        for index, builder in enumerate(builders)
    ]
    if not samples:
        raise ValueError("slime sample requires at least one trainable segment")
    return samples


def _load_json(path: str | Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"JSON artifact must be an object: {path}")
    return value


def _resolve_ref(root: Path, uri: str) -> Path:
    path = Path(uri)
    return path if path.is_absolute() else root / uri


class _TrajectorySampleBuilder:
    def __init__(self, *, fork_threshold_tokens: int) -> None:
        self.fork_threshold_tokens = fork_threshold_tokens
        self.tokens: list[int] = []
        self.loss_mask: list[int] = []
        self.rollout_log_probs: list[float] = []
        self.leading_prompt_len: int | None = None
        self.last_response_start: int | None = None
        self.metadata: dict[str, Any] = {"drift_events": []}

    def can_append(self, capture: dict[str, Any]) -> bool:
        if not self.tokens:
            return True
        prompt_ids = capture["promptIds"]
        common = _common_prefix_len(self.tokens, prompt_ids)
        if common == len(self.tokens):
            return True
        return self._can_realign(common, capture)

    def append(self, capture: dict[str, Any]) -> None:
        prompt_ids = capture["promptIds"]
        output_ids = capture["outputIds"]
        logprobs = capture.get("outputLogProbs", [])
        common = _common_prefix_len(self.tokens, prompt_ids)
        if common == len(self.tokens):
            self._append_prompt_tail(prompt_ids[common:])
        elif self._can_realign(common, capture):
            self._realign_to_prompt(prompt_ids, common)
        else:
            raise ValueError("token capture prompt does not extend the accumulated trajectory prefix")
        if self.leading_prompt_len is None:
            self.leading_prompt_len = len(prompt_ids)
        self.last_response_start = len(self.tokens)
        self.tokens.extend(output_ids)
        self.loss_mask.extend(capture["responseMask"])
        self.rollout_log_probs.extend(logprobs)

    def has_trainable_response(self) -> bool:
        start = self.leading_prompt_len
        return start is not None and any(self.loss_mask[start:])

    def to_sample(
        self,
        *,
        reward: dict[str, Any],
        trajectory: dict[str, Any],
        trajectory_path: str | Path,
        reward_path: str | Path,
        token_capture_refs: list[str],
        fork_index: int,
        fork_count: int,
    ) -> dict[str, Any]:
        if self.leading_prompt_len is None:
            raise ValueError("slime sample requires at least one token capture")
        response_length = len(self.tokens) - self.leading_prompt_len
        response_loss_mask = self.loss_mask[self.leading_prompt_len :]
        response_log_probs = self.rollout_log_probs[self.leading_prompt_len :]
        if response_length <= 0:
            raise ValueError("slime sample requires non-empty response tokens")
        if len(response_loss_mask) != response_length:
            raise ValueError("loss_mask length does not match response_length")
        if len(response_log_probs) != response_length:
            raise ValueError("rollout_log_probs length does not match response_length")
        if not any(response_loss_mask):
            raise ValueError("slime sample requires at least one trainable token")
        raw_reward = reward["reward"]
        sample_reward = raw_reward / fork_count if fork_count > 1 else raw_reward
        return {
            "rollout_id": trajectory["rolloutId"],
            "tokens": self.tokens,
            "response_length": response_length,
            "loss_mask": response_loss_mask,
            "rollout_log_probs": response_log_probs,
            "reward": sample_reward,
            "status": "completed",
            "metadata": {
                "rollout_id": trajectory["rolloutId"],
                "task_id": trajectory["taskId"],
                "agent_kernel_session_id": trajectory["sessionId"],
                "fork_index": fork_index,
                "fork_count": fork_count,
                "agent_kernel_raw_reward": raw_reward,
                "agent_kernel_reward_share": sample_reward,
                **self.metadata,
                "agent_kernel_artifacts": {
                    "trajectory": str(trajectory_path),
                    "reward": str(reward_path),
                    "token_captures": token_capture_refs,
                },
            },
        }

    def _append_prompt_tail(self, ids: list[int]) -> None:
        self.tokens.extend(ids)
        self.loss_mask.extend([0] * len(ids))
        self.rollout_log_probs.extend([0.0] * len(ids))

    def _can_realign(self, common: int, capture: dict[str, Any]) -> bool:
        return (
            self.last_response_start is not None
            and common >= self.last_response_start
            and len(capture["outputIds"]) < self.fork_threshold_tokens
        )

    def _realign_to_prompt(self, prompt_ids: list[int], common: int) -> None:
        assert self.last_response_start is not None
        drift = len(self.tokens) - common
        self.metadata["drift_events"].append({"kind": "realign", "commonPrefix": common, "driftTokens": drift})
        tail = prompt_ids[self.last_response_start :]
        self.tokens[self.last_response_start :] = tail
        self.loss_mask[self.last_response_start :] = [0] * len(tail)
        self.rollout_log_probs[self.last_response_start :] = [0.0] * len(tail)


def _common_prefix_len(left: list[int], right: list[int]) -> int:
    limit = min(len(left), len(right))
    for index in range(limit):
        if left[index] != right[index]:
            return index
    return limit


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
