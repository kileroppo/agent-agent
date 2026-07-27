#!/usr/bin/env bash
set -euo pipefail

private_env="${AGENT_ARMY_MAC_WORKER_ENV:-$HOME/.agent-army/mac-worker.env}"
if [[ ! -f "$private_env" ]]; then
  echo "Mac工作间私有配置不存在。" >&2
  exit 1
fi
set -a
source "$private_env"
set +a

if [[ "${AGENT_ARMY_CLOUD_TRANSPORT:-}" != "iap-ssh" ]]; then
  echo "Mac工作间云连接方式必须为 iap-ssh。" >&2
  exit 1
fi

gcloud_bin="${AGENT_ARMY_GCLOUD_BIN:-}"
if [[ ! -x "$gcloud_bin" ]]; then
  echo "Google Cloud CLI 路径无效。" >&2
  exit 1
fi

local_port="${AGENT_ARMY_IAP_LOCAL_PORT:-44321}"
if [[ ! "$local_port" =~ ^[0-9]+$ ]] || (( local_port < 1024 || local_port > 65535 )); then
  echo "IAP 本机端口无效。" >&2
  exit 1
fi

exec "$gcloud_bin" compute ssh "$AGENT_ARMY_GCP_INSTANCE" \
  "--project=$AGENT_ARMY_GCP_PROJECT" \
  "--zone=$AGENT_ARMY_GCP_ZONE" \
  --tunnel-through-iap \
  --quiet \
  -- \
  -N \
  -T \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L "127.0.0.1:${local_port}:127.0.0.1:4321"
