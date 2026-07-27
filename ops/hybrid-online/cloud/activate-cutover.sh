#!/usr/bin/env bash
set -euo pipefail

required_confirmation="ACTIVATE_CLOUD_EMPLOYEE_CUTOVER"
confirmation="${1:-}"
if [[ "$confirmation" != "$required_confirmation" ]] || \
   [[ "${AGENT_ARMY_CLOUD_ACTIVATE:-}" != "$required_confirmation" ]]; then
  echo "云端员工接管需要命令确认词和独立环境门禁。" >&2
  exit 1
fi
if [[ "$(id -u)" != "0" ]]; then
  echo "云端员工接管必须由 root 执行。" >&2
  exit 1
fi

repo_root="/opt/agent-army/current"
cutover_root="/var/lib/agent-army/private/cutover"
required_files=(
  "$cutover_root/import-complete.json"
  "$cutover_root/local-services-stopped.json"
  "/etc/agent-army/cloud.env"
)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "缺少云端接管证明，拒绝启动员工入口。" >&2
    exit 1
  fi
done

/usr/local/bin/node -e '
const fs = require("node:fs");
const proof = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expected = [
  "ai.agent-army.ajun-runtime",
  "ai.agent-army.paperclip",
  "ai.hermes.gateway",
  "ai.hermes.gateway-intel-researcher",
  "ai.hermes.gateway-office-assistant"
].sort();
if (proof.schemaVersion !== "agent.army/local-services-stopped/v1") process.exit(1);
if (!Array.isArray(proof.services) || proof.services.slice().sort().join(",") !== expected.join(",")) process.exit(1);
' "$cutover_root/local-services-stopped.json" || {
  echo "本机停止证明无效，拒绝云端接管。" >&2
  exit 1
}

rollback_cloud() {
  systemctl disable --now \
    hermes-gateway.service \
    hermes-gateway-intel-researcher.service \
    hermes-gateway-office-assistant.service \
    agent-army-ajun-cloud.service >/dev/null 2>&1 || true
}
activation_complete=false
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 && "$activation_complete" != "true" ]]; then
    rollback_cloud
    echo "云端接管失败；云端员工入口已全部停止。" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

systemctl enable --now agent-army-paperclip.service
systemctl enable --now agent-army-ajun-cloud.service
ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:4321/api/overview >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  echo "A君云端运行时未能就绪。" >&2
  exit 1
fi

systemctl enable --now \
  hermes-gateway-intel-researcher.service \
  hermes-gateway-office-assistant.service
systemctl is-active --quiet hermes-gateway-intel-researcher.service
systemctl is-active --quiet hermes-gateway-office-assistant.service
systemctl enable --now hermes-gateway.service

"$repo_root/ops/hybrid-online/cloud/verify.sh"
/usr/local/bin/node -e '
const fs = require("node:fs");
fs.writeFileSync(process.argv[1], JSON.stringify({
  schemaVersion:"agent.army/cloud-cutover-active/v1",
  activatedAt:new Date().toISOString()
}, null, 2) + "\n", { mode:0o600 });
' "$cutover_root/cloud-active.json"
chown root:agentarmy "$cutover_root/cloud-active.json"
activation_complete=true
echo "云端已成为 A君、小R和小办的唯一飞书入口；等待真实私聊与 Mac 关机验收。"
