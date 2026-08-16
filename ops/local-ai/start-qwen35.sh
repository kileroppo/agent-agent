#!/bin/zsh
set -euo pipefail

readonly RUNTIME_ROOT="${AGENT_ARMY_LOCAL_AI_HOME:-$HOME/Library/Application Support/AgentArmy/local-ai}"
readonly PLUGIN_ROOT="${AGENT_ARMY_LOCAL_AI_PLUGIN_ROOT:-$HOME/Library/Application Support/AgentArmy/plugins/local-ai}"
if [[ -x "$RUNTIME_ROOT/venvs/gateway/bin/python" && -f "$PLUGIN_ROOT/current/bin/launcher.py" ]]; then
  exec "$RUNTIME_ROOT/venvs/gateway/bin/python" "$PLUGIN_ROOT/current/bin/launcher.py" qwen35
fi

# 仅供首次迁移失败后的旧 LaunchAgent 回滚。
readonly REPO_ROOT="${0:A:h:h:h}"
readonly LEGACY_PYTHON="$REPO_ROOT/work/local-ai/venvs/mlx-vlm/bin/python"
readonly PINNED_MODEL="$HOME/.cache/huggingface/hub/models--mlx-community--Qwen3.5-9B-MLX-4bit/snapshots/938d8919941c6e7efd3c7150eff7fe9d12afa631"
[[ -x "$LEGACY_PYTHON" ]] || { print -u2 '本地 AI 插件尚未安装，且没有可回滚的旧环境。'; exit 1; }
readonly MODEL="${LOCAL_AI_QWEN35_MODEL_PATH:-${PINNED_MODEL}}"
exec "$LEGACY_PYTHON" -m mlx_vlm.server --host 127.0.0.1 --port 18081 --model "$MODEL" --max-tokens 4096 --log-level INFO
