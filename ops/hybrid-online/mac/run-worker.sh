#!/usr/bin/env bash
set -euo pipefail

private_env="${AGENT_ARMY_MAC_WORKER_ENV:-$HOME/.agent-army/mac-worker.env}"
if [[ ! -f "$private_env" ]]; then
  echo "Mac工作间私有配置不存在：$private_env" >&2
  exit 1
fi
set -a
source "$private_env"
set +a

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
node_bin="${AGENT_ARMY_NODE_BIN:-}"
if [[ ! -x "$node_bin" ]]; then
  echo "AGENT_ARMY_NODE_BIN 不是可执行的 Node.js 22 路径。" >&2
  exit 1
fi
exec "$node_bin" "$repo_root/apps/mac-worker/src/worker.js"
