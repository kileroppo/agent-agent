#!/usr/bin/env bash
set -euo pipefail

required_confirmation="ROLLBACK_EMPLOYEES_TO_LOCAL"
confirmation="${1:-}"
if [[ "$confirmation" != "$required_confirmation" ]] || \
   [[ "${AGENT_ARMY_LOCAL_ROLLBACK:-}" != "$required_confirmation" ]]; then
  echo "本机回退需要命令确认词和独立环境门禁。" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
private_env="${AGENT_ARMY_MAC_WORKER_ENV:-$HOME/.agent-army/mac-worker.env}"
if [[ ! -f "$private_env" ]]; then
  echo "Mac工作间私有配置不存在。" >&2
  exit 1
fi
set -a
source "$private_env"
set +a
gcloud_bin="${AGENT_ARMY_GCLOUD_BIN:-}"
if [[ ! -x "$gcloud_bin" ]]; then
  echo "Google Cloud CLI 路径无效。" >&2
  exit 1
fi

remote_stop="sudo systemctl disable --now hermes-gateway.service hermes-gateway-intel-researcher.service hermes-gateway-office-assistant.service agent-army-ajun-cloud.service agent-army-paperclip.service >/dev/null 2>&1 || true; for service in hermes-gateway.service hermes-gateway-intel-researcher.service hermes-gateway-office-assistant.service agent-army-ajun-cloud.service; do sudo systemctl is-active --quiet \"\$service\" && exit 1; done"
"$gcloud_bin" compute ssh "$AGENT_ARMY_GCP_INSTANCE" \
  "--project=$AGENT_ARMY_GCP_PROJECT" \
  "--zone=$AGENT_ARMY_GCP_ZONE" \
  --tunnel-through-iap \
  --quiet \
  "--command=$remote_stop" || {
    echo "无法确认云端入口停止；为避免双端接管，拒绝启动本机入口。" >&2
    exit 1
  }

uid="$(id -u)"
domain="gui/$uid"
launch_agents="$HOME/Library/LaunchAgents"
for entry in \
  "ai.agent-army.paperclip|$launch_agents/ai.agent-army.paperclip.plist" \
  "ai.agent-army.ajun-runtime|$launch_agents/ai.agent-army.ajun-runtime.plist" \
  "ai.hermes.gateway|$launch_agents/ai.hermes.gateway.plist" \
  "ai.hermes.gateway-intel-researcher|$launch_agents/ai.hermes.gateway-intel-researcher.plist" \
  "ai.hermes.gateway-office-assistant|$launch_agents/ai.hermes.gateway-office-assistant.plist"; do
  label="${entry%%|*}"
  plist="${entry#*|}"
  launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 || true
  launchctl enable "$domain/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
done

ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:4321/api/overview >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  echo "本机 A君 未能恢复健康。" >&2
  exit 1
fi
for label in ai.hermes.gateway ai.hermes.gateway-intel-researcher ai.hermes.gateway-office-assistant; do
  launchctl print "$domain/$label" 2>/dev/null | grep -q 'state = running' || {
    echo "本机 Hermes Gateway 未恢复：$label" >&2
    exit 1
  }
done

echo "云端入口已停止，本机 A君、小R和小办入口已恢复。"
echo "注意：此脚本只用于首次激活失败的即时回退；云端产生新任务后必须先做反向状态同步。"
