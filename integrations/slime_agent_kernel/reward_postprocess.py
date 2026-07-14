from __future__ import annotations

from collections import defaultdict
from math import sqrt
from typing import Any


def grpo_normalize_by_group_index(args: Any, samples: list[Any]) -> tuple[list[float], list[float]]:
    """Normalize rewards per slime prompt group for fanout samples."""

    raw_rewards = [_reward_value(args, sample) for sample in samples]
    groups: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for index, sample in enumerate(samples):
        groups[_group_index(sample, index)].append((index, raw_rewards[index]))

    normalized = [0.0] * len(samples)
    use_std = getattr(args, "grpo_std_normalization", True)
    for indexed_rewards in groups.values():
        positions = [position for position, _ in indexed_rewards]
        rewards = [reward for _, reward in indexed_rewards]
        mean = sum(rewards) / len(rewards)
        rewards = [reward - mean for reward in rewards]
        if use_std:
            std = _sample_std(rewards)
            rewards = [reward / (std + 1e-6) for reward in rewards]
        for position, reward in zip(positions, rewards, strict=True):
            normalized[position] = reward

    return raw_rewards, normalized


def _reward_value(args: Any, sample: Any) -> float:
    getter = getattr(sample, "get_reward_value", None)
    if callable(getter):
        return float(getter(args))
    if isinstance(sample, dict):
        return float(sample.get("reward", 0.0))
    return float(getattr(sample, "reward", 0.0))


def _group_index(sample: Any, fallback: int) -> int:
    if isinstance(sample, dict):
        value = sample.get("group_index")
    else:
        value = getattr(sample, "group_index", None)
    if value is None:
        return fallback
    return int(value)


def _sample_std(values: list[float]) -> float:
    if len(values) <= 1:
        return 0.0
    return sqrt(sum(value * value for value in values) / (len(values) - 1))
