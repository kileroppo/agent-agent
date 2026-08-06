#!/bin/zsh
set -euo pipefail

readonly LLAMA_ROOT='/Users/pengaro/Documents/work/codeDevelop/ideaSpace/llama'
readonly SERVER="$LLAMA_ROOT/build/bin/llama-server"
readonly MODEL="$LLAMA_ROOT/models/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf"

exec "$SERVER" \
  -m "$MODEL" \
  --host 127.0.0.1 \
  --port 18080 \
  -ngl 99 \
  -c 65536 \
  --parallel 2 \
  --reasoning off \
  --reasoning-format none \
  --alias qwen3.6-local
