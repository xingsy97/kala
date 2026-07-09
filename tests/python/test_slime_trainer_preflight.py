from pathlib import Path

from integrations.slime_agent_kernel.preflight import decision_text, run_preflight


def test_preflight_blocks_when_flash_attn_extension_is_missing(tmp_path: Path) -> None:
    slime = write_minimal_slime_tree(tmp_path)

    result = run_preflight(slime, import_modules=("json", "definitely_missing_flash_attn_2_cuda_for_test"))

    failed = {check["name"] for check in result["checks"] if not check["ok"]}
    assert "import:definitely_missing_flash_attn_2_cuda_for_test" in failed
    assert result["ok"] is False
    assert result["decision"].startswith("blocked:")


def test_preflight_passes_source_contracts_for_qwen_hf_ref_load(tmp_path: Path) -> None:
    slime = write_minimal_slime_tree(tmp_path)

    result = run_preflight(slime, import_modules=("json",))

    assert result["ok"] is True
    names = {check["name"] for check in result["checks"]}
    assert 'source:data.py:qkv_format="thd"' in names
    assert "source:test_qwen2.5_0.5B_short.py:--ref-load /root/models/{MODEL_NAME}/" in names
    assert "source:test_qwen2.5_0.5B_short.py:--attention-backend flash" in names


def test_decision_mentions_flash_attn_gate_for_real_extension_name() -> None:
    class Failed:
        name = "import:flash_attn_2_cuda"
        ok = False

    assert "flash_attn_2_cuda is missing" in decision_text([Failed()])


def write_minimal_slime_tree(tmp_path: Path) -> Path:
    root = tmp_path / "slime"
    (root / "slime/backends/megatron_utils").mkdir(parents=True)
    (root / "tests").mkdir(parents=True)
    (root / "scripts/models").mkdir(parents=True)
    (root / "slime/backends/megatron_utils/data.py").write_text(
        'from megatron.core.packed_seq_params import PackedSeqParams\nPackedSeqParams(qkv_format="thd")\n',
        encoding="utf-8",
    )
    (root / "tests/test_qwen2.5_0.5B_short.py").write_text(
        'ckpt_args = f"--hf-checkpoint /root/models/{MODEL_NAME}/ " f"--ref-load /root/models/{MODEL_NAME}/ "\n'
        'misc_args = "--attention-backend flash --megatron-to-hf-mode bridge "\n',
        encoding="utf-8",
    )
    (root / "scripts/models/qwen2.5-0.5B.sh").write_text(
        "MODEL_ARGS=(\n  --num-layers 24\n  --num-query-groups 2\n)\n",
        encoding="utf-8",
    )
    return root
