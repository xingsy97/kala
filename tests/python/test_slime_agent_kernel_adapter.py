import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from integrations.slime_agent_kernel.generate import generate
from integrations.slime_agent_kernel.reward_postprocess import grpo_normalize_by_group_index


def test_generate_builds_sample_from_agent_kernel_artifacts(tmp_path: Path) -> None:
    capture_dir = tmp_path / "rl-token-captures" / "rollout-1"
    capture_dir.mkdir(parents=True)
    capture_path = capture_dir / "capture-1.json"
    capture_path.write_text(
        json.dumps(
            {
                "schemaVersion": "agent.policy_token_capture.v1",
                "captureId": "capture-1",
                "rolloutId": "rollout-1",
                "sessionId": "session-1",
                "callId": "call-1",
                "provider": "policy-gateway",
                "backend": "sglang",
                "model": "fake-policy",
                "tokenizer": {"nameOrPath": "fake-policy", "chatTemplateHash": "hash"},
                "promptIds": [1, 2, 3],
                "outputIds": [4, 5],
                "outputLogProbs": [-0.1, -0.2],
                "responseMask": [1, 1],
            }
        ),
        encoding="utf-8",
    )
    trajectory_dir = tmp_path / "rl-trajectories"
    trajectory_dir.mkdir()
    trajectory_path = trajectory_dir / "rollout-1.json"
    trajectory_path.write_text(
        json.dumps(
            {
                "schemaVersion": "agent.training_trajectory.v1",
                "rolloutId": "rollout-1",
                "taskId": "task-1",
                "sessionId": "session-1",
                "turns": [
                    {
                        "turnIndex": 0,
                        "callId": "call-1",
                        "promptTokenCount": 3,
                        "responseTokenCount": 2,
                        "tokenCaptureRef": {
                            "kind": "rl_token_capture",
                            "uri": "rl-token-captures/rollout-1/capture-1.json",
                            "sha256": "x",
                            "bytes": 1,
                            "mediaType": "application/json",
                        },
                        "lossMaskStart": 0,
                        "lossMaskEnd": 2,
                        "role": "assistant_policy_output",
                    }
                ],
                "readiness": "reward-verified",
            }
        ),
        encoding="utf-8",
    )
    reward_path = tmp_path / "reward.json"
    reward_path.write_text(
        json.dumps(
            {
                "schemaVersion": "agent.reward.v1",
                "rolloutId": "rollout-1",
                "taskId": "task-1",
                "verifierKind": "command",
                "reward": 1,
                "label": "resolved",
                "startedAt": "2026-07-12T00:00:00.000Z",
                "completedAt": "2026-07-12T00:00:01.000Z",
                "durationMs": 1000,
            }
        ),
        encoding="utf-8",
    )

    sample = {"metadata": {"trajectory_path": str(trajectory_path), "reward_path": str(reward_path)}}
    result = asyncio.run(generate(object(), sample, {}))

    assert result["tokens"] == [1, 2, 3, 4, 5]
    assert result["response_length"] == 2
    assert result["loss_mask"] == [1, 1]
    assert result["rollout_log_probs"] == [-0.1, -0.2]
    assert result["reward"] == 1
    assert result["metadata"]["rollout_id"] == "rollout-1"


def test_generate_returns_list_for_slime_sample_object(tmp_path: Path) -> None:
    write_artifacts(tmp_path, rollout_id="rollout-object")
    sample = SimpleNamespace(
        metadata={
            "trajectory_path": str(tmp_path / "rl-trajectories" / "rollout-object.json"),
            "reward_path": str(tmp_path / "rl-rewards" / "rollout-object.json"),
        },
        status="pending",
    )

    result = asyncio.run(generate(object(), sample, {}))

    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0].rollout_id == "rollout-object"
    assert result[0].metadata["rollout_id"] == "rollout-object"


def test_generate_live_mode_calls_agent_kernel_cli_and_builds_sample(tmp_path: Path) -> None:
    fixture = write_artifacts(tmp_path, rollout_id="rollout-live")
    cli = tmp_path / "fake-agent-kernel-host"
    cli.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "assert sys.argv[1:4] == ['rl', 'run-rollout-smoke', '--root-dir']\n"
        "print(json.dumps({\n"
        "  'artifact': {'uri': 'rl-rollouts/rollout-live.json'},\n"
        "  'result': {\n"
        "    'readiness': 'slime-sample-ready',\n"
        "    'trajectoryRef': {'uri': 'rl-trajectories/rollout-live.json'},\n"
        "    'rewardRef': {'uri': 'rl-rewards/rollout-live.json'}\n"
        "  }\n"
        "}))\n",
        encoding="utf-8",
    )
    cli.chmod(0o755)
    task_file = tmp_path / "tasks.jsonl"
    task_file.write_text('{"schemaVersion":"agent.rl.task.v1"}\n', encoding="utf-8")
    sample = {
        "metadata": {
            "agent_kernel_task_file": str(task_file),
            "agent_kernel_root_dir": str(tmp_path),
            "agent_kernel_cli": str(cli),
            "rollout_id": "rollout-live",
            "fixture_policy": True,
        }
    }

    result = asyncio.run(generate(object(), sample, {}))

    assert fixture.exists()
    assert result["response_length"] == 2
    assert result["metadata"]["rollout_id"] == "rollout-live"


def test_generate_live_mode_accepts_agent_kernel_cli_argv(tmp_path: Path) -> None:
    write_artifacts(tmp_path, rollout_id="rollout-live-argv")
    cli = tmp_path / "fake-agent-kernel-host.py"
    cli.write_text(
        "import json, sys\n"
        "assert sys.argv[1:4] == ['rl', 'run-rollout-smoke', '--root-dir']\n"
        "assert '--policy-base-url' in sys.argv\n"
        "assert sys.argv[sys.argv.index('--policy-base-url') + 1] == 'http://127.0.0.1:30000'\n"
        "print(json.dumps({\n"
        "  'result': {\n"
        "    'readiness': 'slime-sample-ready',\n"
        "    'trajectoryRef': {'uri': 'rl-trajectories/rollout-live-argv.json'},\n"
        "    'rewardRef': {'uri': 'rl-rewards/rollout-live-argv.json'}\n"
        "  }\n"
        "}))\n",
        encoding="utf-8",
    )
    task_file = tmp_path / "tasks.jsonl"
    task_file.write_text('{"schemaVersion":"agent.rl.task.v1"}\n', encoding="utf-8")
    sample = {
        "metadata": {
            "agent_kernel_task_file": str(task_file),
            "agent_kernel_root_dir": str(tmp_path),
            "agent_kernel_cli": ["python3", str(cli)],
            "agent_kernel_policy_base_url": "http://127.0.0.1:30000",
            "agent_kernel_rollout_id": "rollout-live-argv",
        }
    }

    result = asyncio.run(generate(object(), sample, {}))

    assert result["metadata"]["rollout_id"] == "rollout-live-argv"
    assert result["reward"] == 1


def test_generate_live_mode_selects_indexed_rollout_and_task_ids(tmp_path: Path) -> None:
    write_artifacts(tmp_path, rollout_id="rollout-live-list-1")
    cli = tmp_path / "fake-agent-kernel-host.py"
    cli.write_text(
        "import json, sys\n"
        "assert sys.argv[sys.argv.index('--rollout-id') + 1] == 'rollout-live-list-1'\n"
        "assert sys.argv[sys.argv.index('--task-id') + 1] == 'task-fail'\n"
        "print(json.dumps({\n"
        "  'result': {\n"
        "    'readiness': 'slime-sample-ready',\n"
        "    'trajectoryRef': {'uri': 'rl-trajectories/rollout-live-list-1.json'},\n"
        "    'rewardRef': {'uri': 'rl-rewards/rollout-live-list-1.json'}\n"
        "  }\n"
        "}))\n",
        encoding="utf-8",
    )
    task_file = tmp_path / "tasks.jsonl"
    task_file.write_text('{"schemaVersion":"agent.rl.task.v1"}\n', encoding="utf-8")
    sample = SimpleNamespace(
        index=1,
        metadata={
            "agent_kernel_task_file": str(task_file),
            "agent_kernel_root_dir": str(tmp_path),
            "agent_kernel_cli": ["python3", str(cli)],
            "agent_kernel_rollout_id": ["rollout-live-list-0", "rollout-live-list-1"],
            "agent_kernel_task_id": ["task-pass", "task-fail"],
        },
        status="pending",
    )

    result = asyncio.run(generate(object(), sample, {}))

    assert result[0].metadata["rollout_id"] == "rollout-live-list-1"
    assert result[0].reward == 1


def test_generate_builds_multi_turn_prefix_incremental_sample(tmp_path: Path) -> None:
    capture_dir = tmp_path / "rl-token-captures" / "rollout-multi"
    capture_dir.mkdir(parents=True)
    captures = [
        ("capture-1.json", [1, 2, 3], [4, 5], [-0.1, -0.2]),
        ("capture-2.json", [1, 2, 3, 4, 5, 6, 7], [8], [-0.3]),
    ]
    for name, prompt_ids, output_ids, logprobs in captures:
        (capture_dir / name).write_text(
            json.dumps(
                {
                    "schemaVersion": "agent.policy_token_capture.v1",
                    "captureId": name,
                    "rolloutId": "rollout-multi",
                    "sessionId": "session-1",
                    "callId": name,
                    "provider": "policy-gateway",
                    "backend": "sglang",
                    "model": "fake-policy",
                    "tokenizer": {"nameOrPath": "fake-policy", "chatTemplateHash": "hash"},
                    "promptIds": prompt_ids,
                    "outputIds": output_ids,
                    "outputLogProbs": logprobs,
                    "responseMask": [1] * len(output_ids),
                }
            ),
            encoding="utf-8",
        )
    trajectory_dir = tmp_path / "rl-trajectories"
    trajectory_dir.mkdir()
    trajectory_path = trajectory_dir / "rollout-multi.json"
    trajectory_path.write_text(
        json.dumps(
            {
                "schemaVersion": "agent.training_trajectory.v1",
                "rolloutId": "rollout-multi",
                "taskId": "task-1",
                "sessionId": "session-1",
                "turns": [
                    {"turnIndex": 0, "callId": "capture-1.json", "promptTokenCount": 3, "responseTokenCount": 2, "tokenCaptureRef": {"kind": "rl_token_capture", "uri": "rl-token-captures/rollout-multi/capture-1.json", "sha256": "x", "bytes": 1, "mediaType": "application/json"}, "lossMaskStart": 0, "lossMaskEnd": 2, "role": "assistant_policy_output"},
                    {"turnIndex": 1, "callId": "capture-2.json", "promptTokenCount": 7, "responseTokenCount": 1, "tokenCaptureRef": {"kind": "rl_token_capture", "uri": "rl-token-captures/rollout-multi/capture-2.json", "sha256": "x", "bytes": 1, "mediaType": "application/json"}, "lossMaskStart": 0, "lossMaskEnd": 1, "role": "assistant_policy_output"},
                ],
                "readiness": "reward-verified",
            }
        ),
        encoding="utf-8",
    )
    reward_path = tmp_path / "reward.json"
    reward_path.write_text(
        json.dumps({"schemaVersion": "agent.reward.v1", "rolloutId": "rollout-multi", "taskId": "task-1", "verifierKind": "command", "reward": 1, "label": "resolved", "startedAt": "2026-07-12T00:00:00.000Z", "completedAt": "2026-07-12T00:00:01.000Z", "durationMs": 1000}),
        encoding="utf-8",
    )

    result = asyncio.run(generate(object(), {"metadata": {"trajectory_path": str(trajectory_path), "reward_path": str(reward_path)}}, {}))

    assert result["tokens"] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert result["response_length"] == 5
    assert result["loss_mask"] == [1, 1, 0, 0, 1]
    assert result["rollout_log_probs"] == [-0.1, -0.2, 0.0, 0.0, -0.3]


def test_generate_splits_reward_across_fanout_samples(tmp_path: Path) -> None:
    capture_dir = tmp_path / "rl-token-captures" / "rollout-fanout"
    capture_dir.mkdir(parents=True)
    captures = [
        ("capture-1.json", [1, 2, 3], [4, 5], [-0.1, -0.2]),
        ("capture-2.json", [9, 9, 9], [10, 11], [-0.3, -0.4]),
    ]
    for name, prompt_ids, output_ids, logprobs in captures:
        (capture_dir / name).write_text(
            json.dumps(
                {
                    "schemaVersion": "agent.policy_token_capture.v1",
                    "captureId": name,
                    "rolloutId": "rollout-fanout",
                    "sessionId": "session-1",
                    "callId": name,
                    "provider": "policy-gateway",
                    "backend": "sglang",
                    "model": "fake-policy",
                    "tokenizer": {"nameOrPath": "fake-policy", "chatTemplateHash": "hash"},
                    "promptIds": prompt_ids,
                    "outputIds": output_ids,
                    "outputLogProbs": logprobs,
                    "responseMask": [1] * len(output_ids),
                }
            ),
            encoding="utf-8",
        )
    trajectory_dir = tmp_path / "rl-trajectories"
    trajectory_dir.mkdir()
    trajectory_path = trajectory_dir / "rollout-fanout.json"
    trajectory_path.write_text(
        json.dumps(
            {
                "schemaVersion": "agent.training_trajectory.v1",
                "rolloutId": "rollout-fanout",
                "taskId": "task-1",
                "sessionId": "session-1",
                "turns": [
                    {"turnIndex": 0, "callId": "capture-1.json", "promptTokenCount": 3, "responseTokenCount": 2, "tokenCaptureRef": {"kind": "rl_token_capture", "uri": "rl-token-captures/rollout-fanout/capture-1.json", "sha256": "x", "bytes": 1, "mediaType": "application/json"}, "lossMaskStart": 0, "lossMaskEnd": 2, "role": "assistant_policy_output"},
                    {"turnIndex": 1, "callId": "capture-2.json", "promptTokenCount": 3, "responseTokenCount": 2, "tokenCaptureRef": {"kind": "rl_token_capture", "uri": "rl-token-captures/rollout-fanout/capture-2.json", "sha256": "x", "bytes": 1, "mediaType": "application/json"}, "lossMaskStart": 0, "lossMaskEnd": 2, "role": "assistant_policy_output"},
                ],
                "readiness": "reward-verified",
            }
        ),
        encoding="utf-8",
    )
    reward_path = tmp_path / "reward.json"
    reward_path.write_text(
        json.dumps({"schemaVersion": "agent.reward.v1", "rolloutId": "rollout-fanout", "taskId": "task-1", "verifierKind": "command", "reward": 1, "label": "resolved", "startedAt": "2026-07-12T00:00:00.000Z", "completedAt": "2026-07-12T00:00:01.000Z", "durationMs": 1000}),
        encoding="utf-8",
    )

    result = asyncio.run(generate(SimpleNamespace(), SimpleNamespace(metadata={"trajectory_path": str(trajectory_path), "reward_path": str(reward_path)}, status="pending"), {}))

    assert len(result) == 2
    assert [sample.rollout_id for sample in result] == ["rollout-fanout", "rollout-fanout"]
    assert [sample.reward for sample in result] == [0.5, 0.5]
    assert [sample.metadata["fork_count"] for sample in result] == [2, 2]
    assert [sample.metadata["agent_kernel_raw_reward"] for sample in result] == [1, 1]


def test_reward_postprocess_normalizes_by_group_index() -> None:
    class FakeSample:
        def __init__(self, reward: float, group_index: int) -> None:
            self.reward = reward
            self.group_index = group_index

        def get_reward_value(self, _args: object) -> float:
            return self.reward

    samples = [FakeSample(1, 7), FakeSample(0, 7), FakeSample(0.5, 8), FakeSample(0.5, 8)]
    raw_rewards, rewards = grpo_normalize_by_group_index(SimpleNamespace(grpo_std_normalization=False), samples)

    assert raw_rewards == [1.0, 0.0, 0.5, 0.5]
    assert rewards == [0.5, -0.5, 0.0, 0.0]


def write_artifacts(tmp_path: Path, *, rollout_id: str) -> Path:
    capture_dir = tmp_path / "rl-token-captures" / rollout_id
    capture_dir.mkdir(parents=True)
    (capture_dir / "capture-1.json").write_text(
        json.dumps(
            {
                "schemaVersion": "agent.policy_token_capture.v1",
                "captureId": "capture-1",
                "rolloutId": rollout_id,
                "sessionId": "session-1",
                "callId": "call-1",
                "provider": "policy-gateway",
                "backend": "sglang",
                "model": "fake-policy",
                "tokenizer": {"nameOrPath": "fake-policy", "chatTemplateHash": "hash"},
                "promptIds": [1, 2, 3],
                "outputIds": [4, 5],
                "outputLogProbs": [-0.1, -0.2],
                "responseMask": [1, 1],
            }
        ),
        encoding="utf-8",
    )
    trajectory_dir = tmp_path / "rl-trajectories"
    trajectory_dir.mkdir()
    trajectory_path = trajectory_dir / f"{rollout_id}.json"
    trajectory_path.write_text(
        json.dumps(
            {
                "schemaVersion": "agent.training_trajectory.v1",
                "rolloutId": rollout_id,
                "taskId": "task-live",
                "sessionId": "session-1",
                "turns": [
                    {
                        "turnIndex": 0,
                        "callId": "call-1",
                        "promptTokenCount": 3,
                        "responseTokenCount": 2,
                        "tokenCaptureRef": {
                            "kind": "rl_token_capture",
                            "uri": f"rl-token-captures/{rollout_id}/capture-1.json",
                            "sha256": "x",
                            "bytes": 1,
                            "mediaType": "application/json",
                        },
                        "lossMaskStart": 0,
                        "lossMaskEnd": 2,
                        "role": "assistant_policy_output",
                    }
                ],
                "readiness": "reward-verified",
            }
        ),
        encoding="utf-8",
    )
    reward_dir = tmp_path / "rl-rewards"
    reward_dir.mkdir()
    (reward_dir / f"{rollout_id}.json").write_text(
        json.dumps(
            {
                "schemaVersion": "agent.reward.v1",
                "rolloutId": rollout_id,
                "taskId": "task-live",
                "verifierKind": "command",
                "reward": 1,
                "label": "resolved",
                "startedAt": "2026-07-12T00:00:00.000Z",
                "completedAt": "2026-07-12T00:00:01.000Z",
                "durationMs": 1000,
            }
        ),
        encoding="utf-8",
    )
    return trajectory_path
