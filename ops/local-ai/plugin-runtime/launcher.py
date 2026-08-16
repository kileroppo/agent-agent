#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import stat
import sys


RUNTIME_ROOT = Path(
    os.environ.get(
        "AGENT_ARMY_LOCAL_AI_HOME",
        Path.home() / "Library/Application Support/AgentArmy/local-ai",
    )
).expanduser().resolve()
RELEASE_ROOT = Path(__file__).resolve().parents[1]
LIB_ROOT = RELEASE_ROOT / "lib"
MODEL_MANIFEST = RELEASE_ROOT / "model-manifest.json"
CONFIG_FILE = RUNTIME_ROOT / "config.json"
PAIRING_FILE = RUNTIME_ROOT / "mac-pairing.json"


def load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise RuntimeError(f"配置必须是 JSON 对象: {path}")
    return value


def model_reference(model_id: str, config: dict) -> str:
    configured = config.get("models", {}).get(model_id)
    if isinstance(configured, str) and configured.strip():
        return configured.strip()
    manifest = load_json(MODEL_MANIFEST)
    row = next((item for item in manifest.get("models", []) if item.get("id") == model_id), None)
    if not row:
        raise RuntimeError(f"插件模型清单缺少 {model_id}")
    repo_id = str(row["repoId"])
    revision = str(row["revision"])
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface")).expanduser()
    cached = hf_home / "hub" / f"models--{repo_id.replace('/', '--')}" / "snapshots" / revision
    return str(cached.resolve()) if cached.is_dir() else repo_id


def configured_executable(config: dict, key: str, candidates: list[str]) -> str:
    configured = config.get("executables", {}).get(key)
    if isinstance(configured, str) and configured.strip():
        return configured.strip()
    for candidate in candidates:
        located = shutil.which(candidate)
        if located:
            return located
    return candidates[0]


def gateway_environment(config: dict) -> dict[str, str]:
    environment = dict(os.environ)
    environment.update(
        {
            "AGENT_ARMY_ROOT": str(RELEASE_ROOT),
            "LOCAL_AI_WORK_ROOT": str(RUNTIME_ROOT),
            "LOCAL_AI_HOST": "127.0.0.1",
            "LOCAL_AI_PORT": "18082",
            "LOCAL_AI_QWEN_MODEL": model_reference("qwen35", config),
            "LOCAL_AI_TTS_MODEL": model_reference("tts", config),
            "LOCAL_AI_EMBEDDING_MODEL": model_reference("embedding", config),
            "LOCAL_AI_RERANKER_MODEL": model_reference("reranker", config),
            "LOCAL_AI_FLUX_MODEL": model_reference("mflux", config),
            "LOCAL_AI_WHISPER_MODEL": model_reference("whisper", config),
            "LOCAL_AI_TTS_PYTHON": str(RUNTIME_ROOT / "venvs/gateway/bin/python"),
            "LOCAL_AI_MFLUX_GENERATE": str(RELEASE_ROOT / "bin/mflux-generate-flux2"),
            "LOCAL_AI_MFLUX_EDIT": str(RELEASE_ROOT / "bin/mflux-generate-flux2-edit"),
            "LOCAL_AI_MLX_WHISPER": configured_executable(
                config,
                "mlxWhisper",
                [str(RUNTIME_ROOT / "venvs/gateway/bin/mlx_whisper"), str(Path.home() / ".local/bin/mlx_whisper"), "mlx_whisper"],
            ),
            "LOCAL_AI_FFMPEG": configured_executable(config, "ffmpeg", ["/opt/homebrew/bin/ffmpeg", "ffmpeg"]),
            "LOCAL_AI_FFPROBE": configured_executable(config, "ffprobe", ["/opt/homebrew/bin/ffprobe", "ffprobe"]),
            "PYTHONPATH": str(LIB_ROOT),
            "WECHAT_LOCAL_MODEL_BASE_URL": "http://127.0.0.1:18081",
        }
    )
    if PAIRING_FILE.is_file():
        mode = stat.S_IMODE(PAIRING_FILE.stat().st_mode)
        if mode != 0o600:
            raise RuntimeError("mac-pairing.json 权限必须是 0600")
        pairing = load_json(PAIRING_FILE)
        environment["LOCAL_AI_DESKTOP_BASE_URL"] = str(pairing["baseUrl"])
        environment["LOCAL_AI_DESKTOP_TOKEN"] = str(pairing["token"])
    return environment


def exec_gateway(config: dict) -> None:
    python = RUNTIME_ROOT / "venvs/gateway/bin/python"
    os.execve(str(python), [str(python), str(LIB_ROOT / "local_ai_gateway.py")], gateway_environment(config))


def exec_qwen35(config: dict) -> None:
    python = RUNTIME_ROOT / "venvs/gateway/bin/python"
    model = model_reference("qwen35", config)
    args = [
        str(python), "-m", "mlx_vlm.server", "--host", "127.0.0.1", "--port", "18081",
        "--model", model, "--max-tokens", "4096", "--log-level", "INFO",
    ]
    os.execve(str(python), args, dict(os.environ))


def exec_qwen36(config: dict) -> None:
    settings = config.get("qwen36", {})
    server = Path(str(settings.get("serverPath", ""))).expanduser()
    model = Path(str(settings.get("modelPath", ""))).expanduser()
    if not server.is_file() or not model.is_file():
        raise RuntimeError("Qwen3.6 候选未配置；请在外置 config.json 设置 qwen36.serverPath 和 modelPath")
    args = [str(server), "-m", str(model), "--host", "127.0.0.1", "--port", "18080", "-ngl", "99", "-c", "65536", "--parallel", "2", "--reasoning", "off", "--reasoning-format", "none", "--alias", "qwen3.6-local"]
    os.execve(str(server), args, dict(os.environ))


def main() -> None:
    if len(sys.argv) != 2:
        raise RuntimeError("用法: launcher.py gateway|qwen35|qwen36-candidate")
    command = sys.argv[1]
    config = load_json(CONFIG_FILE)
    if command == "gateway":
        exec_gateway(config)
    if command == "qwen35":
        exec_qwen35(config)
    if command == "qwen36-candidate":
        exec_qwen36(config)
    raise RuntimeError(f"未知插件命令: {command}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"local-ai plugin launcher: {error}", file=sys.stderr)
        raise SystemExit(1)
