#!/usr/bin/env bash
set -euo pipefail

required_confirmation="SWITCH_EMPLOYEES_TO_PRIVATE_CLOUD"
apply=false
confirmation=""
archive_name=""
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --confirm=*) confirmation="${arg#--confirm=}" ;;
    --archive-name=*) archive_name="${arg#--archive-name=}" ;;
    *) echo "无法识别参数；默认只输出计划。" >&2; exit 1 ;;
  esac
done

if [[ "$apply" != "true" ]]; then
  echo "云端唯一接管预览"
  echo "- 再次确认本机 A君、Paperclip 与三套 Hermes Gateway 全部停止"
  echo "- 云端导入并逐文件校验迁移归档，恢复 Paperclip 但先不接管"
  echo "- 依次启动 A君、小R、小办，最后启动 A君 Hermes Gateway"
  echo "- 云端任一步失败时先确认云端全部停止，再自动恢复本机入口"
  echo "- 成功后启动 IAP 隧道与 Mac 工作间，不会重启本机飞书入口"
  exit 0
fi

if [[ "$confirmation" != "$required_confirmation" ]] || \
   [[ "${AGENT_ARMY_CLOUD_SWITCH:-}" != "$required_confirmation" ]]; then
  echo "云端唯一接管需要命令确认词和独立环境门禁。" >&2
  exit 1
fi
if [[ ! "$archive_name" =~ ^agent-army-cutover-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]]; then
  echo "云端迁移归档名称无效。" >&2
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

uid="$(id -u)"
domain="gui/$uid"
launch_agents="$HOME/Library/LaunchAgents"
local_services=(
  "ai.agent-army.ajun-runtime|$launch_agents/ai.agent-army.ajun-runtime.plist"
  "ai.agent-army.paperclip|$launch_agents/ai.agent-army.paperclip.plist"
  "ai.hermes.gateway|$launch_agents/ai.hermes.gateway.plist"
  "ai.hermes.gateway-intel-researcher|$launch_agents/ai.hermes.gateway-intel-researcher.plist"
  "ai.hermes.gateway-office-assistant|$launch_agents/ai.hermes.gateway-office-assistant.plist"
)

service_is_running() {
  launchctl print "$domain/$1" 2>/dev/null | grep -q 'state = running'
}

for entry in "${local_services[@]}"; do
  label="${entry%%|*}"
  if service_is_running "$label"; then
    echo "本机员工入口仍在运行，拒绝形成双端接管：$label" >&2
    exit 1
  fi
done

remote_ssh() {
  local command="$1"
  "$gcloud_bin" compute ssh "$AGENT_ARMY_GCP_INSTANCE" \
    "--project=$AGENT_ARMY_GCP_PROJECT" \
    "--zone=$AGENT_ARMY_GCP_ZONE" \
    --tunnel-through-iap \
    --quiet \
    "--command=$command"
}

start_local_service() {
  local label="$1"
  local plist="$2"
  if service_is_running "$label"; then return; fi
  launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 || true
  launchctl enable "$domain/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
}

restore_local_after_confirmed_cloud_stop() {
  local stop_command="sudo systemctl disable --now hermes-gateway.service hermes-gateway-intel-researcher.service hermes-gateway-office-assistant.service agent-army-ajun-cloud.service agent-army-paperclip.service >/dev/null 2>&1 || true; for service in hermes-gateway.service hermes-gateway-intel-researcher.service hermes-gateway-office-assistant.service agent-army-ajun-cloud.service; do sudo systemctl is-active --quiet \"\$service\" && exit 1; done"
  if ! remote_ssh "$stop_command"; then
    echo "无法确认云端入口已停止；为避免双端接管，本机入口不会自动恢复。" >&2
    return 1
  fi
  for entry in \
    "ai.agent-army.paperclip|$launch_agents/ai.agent-army.paperclip.plist" \
    "ai.agent-army.ajun-runtime|$launch_agents/ai.agent-army.ajun-runtime.plist" \
    "ai.hermes.gateway|$launch_agents/ai.hermes.gateway.plist" \
    "ai.hermes.gateway-intel-researcher|$launch_agents/ai.hermes.gateway-intel-researcher.plist" \
    "ai.hermes.gateway-office-assistant|$launch_agents/ai.hermes.gateway-office-assistant.plist"; do
    start_local_service "${entry%%|*}" "${entry#*|}"
  done
}

switch_complete=false
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 && "$switch_complete" != "true" ]]; then
    restore_local_after_confirmed_cloud_stop || true
    echo "云端接管未完成；已执行受控回退。" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

remote_archive="/var/lib/agent-army/private/cutover/$archive_name"
remote_ssh "sudo test -f '$remote_archive' && sudo test -x /opt/agent-army/current/ops/hybrid-online/cloud/import-cutover-state.sh"
remote_ssh "sudo env AGENT_ARMY_CUTOVER_IMPORT=IMPORT_PRIVATE_CUTOVER_STATE /opt/agent-army/current/ops/hybrid-online/cloud/import-cutover-state.sh IMPORT_PRIVATE_CUTOVER_STATE '$remote_archive'"
remote_ssh "sudo env AGENT_ARMY_CLOUD_ACTIVATE=ACTIVATE_CLOUD_EMPLOYEE_CUTOVER /opt/agent-army/current/ops/hybrid-online/cloud/activate-cutover.sh ACTIVATE_CLOUD_EMPLOYEE_CUTOVER"
remote_ssh "sudo /opt/agent-army/current/ops/hybrid-online/cloud/verify.sh"

"$script_dir/install-launchagent.sh"
switch_complete=true
echo "云端唯一接管已完成；本机只保留 IAP 隧道、Mac 工作间与小D本机执行能力。"
