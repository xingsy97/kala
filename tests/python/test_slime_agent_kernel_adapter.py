import asyncio
import json
from pathlib import Path

from integrations.slime_agent_kernel.generate import generate


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
