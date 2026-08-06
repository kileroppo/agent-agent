#!/bin/zsh
set -euo pipefail

readonly REPO_ROOT='/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent'
readonly PYTHON="$REPO_ROOT/work/local-ai/venvs/mlx-vlm/bin/python"
readonly MODEL='/Users/pengaro/.cache/huggingface/hub/models--mlx-community--Qwen3.5-9B-MLX-4bit/snapshots/938d8919941c6e7efd3c7150eff7fe9d12afa631'

exec "$PYTHON" -m mlx_vlm.server \
  --host 127.0.0.1 \
  --port 18081 \
  --model "$MODEL" \
  --max-tokens 4096 \
  --log-level INFO
