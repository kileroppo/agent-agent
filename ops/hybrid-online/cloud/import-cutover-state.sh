#!/usr/bin/env bash
set -euo pipefail

required_confirmation="IMPORT_PRIVATE_CUTOVER_STATE"
confirmation="${1:-}"
archive="${2:-}"
if [[ "$confirmation" != "$required_confirmation" ]] || \
   [[ "${AGENT_ARMY_CUTOVER_IMPORT:-}" != "$required_confirmation" ]]; then
  echo "云端状态导入需要命令确认词和独立环境门禁。" >&2
  exit 1
fi
if [[ "$(id -u)" != "0" ]]; then
  echo "云端状态导入必须由 root 执行。" >&2
  exit 1
fi

repo_root="/opt/agent-army/current"
data_root="/var/lib/agent-army"
allowed_root="$data_root/private/cutover"
manifest_tool="$repo_root/ops/hybrid-online/cutover/manifest.mjs"
apply_tool="$repo_root/ops/hybrid-online/cutover/apply-state.mjs"
resolved_archive="$(realpath "$archive" 2>/dev/null || true)"
if [[ -z "$resolved_archive" ]] || [[ "$resolved_archive" != "$allowed_root/"* ]] || \
   [[ ! -f "$resolved_archive" ]] || [[ "$(basename "$resolved_archive")" != agent-army-cutover-*.tar.gz ]]; then
  echo "只允许导入云端受控 cutover 目录中的明确归档。" >&2
  exit 1
fi

cloud_services=(
  agent-army-ajun-cloud.service
  hermes-gateway.service
  hermes-gateway-intel-researcher.service
  hermes-gateway-office-assistant.service
)
for service in "${cloud_services[@]}"; do
  if systemctl is-active --quiet "$service"; then
    echo "云端员工服务已运行，拒绝覆盖状态：$service" >&2
    exit 1
  fi
done

staging="$(mktemp -d "$allowed_root/import.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -rf "$staging"
  if [[ "$status" -ne 0 ]]; then
    systemctl disable --now \
      agent-army-ajun-cloud.service \
      hermes-gateway.service \
      hermes-gateway-intel-researcher.service \
      hermes-gateway-office-assistant.service >/dev/null 2>&1 || true
    echo "云端状态导入失败；所有员工入口保持停止。" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if tar -tzf "$resolved_archive" | sed 's#^\./##' | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "迁移归档含不安全路径。" >&2
  exit 1
fi
if tar -tvzf "$resolved_archive" | awk '$1 ~ /^[lh]/ { found=1 } END { exit found ? 0 : 1 }'; then
  echo "迁移归档不允许符号链接或硬链接。" >&2
  exit 1
fi
tar -xzf "$resolved_archive" -C "$staging"
/usr/local/bin/node "$manifest_tool" verify "$staging" >/dev/null
/usr/local/bin/node "$apply_tool" apply "$staging" "$data_root" >/dev/null
installed_backup="$allowed_root/paperclip-cutover-state.sql.gz"
chown -R agentarmy:agentarmy \
  "$data_root/hermes" \
  "$data_root/.paperclip" \
  "$data_root/private" \
  "$data_root/runtime.json"
chown root:agentarmy "$installed_backup" "$allowed_root/local-services-stopped.json"

"$repo_root/ops/hybrid-online/cloud/prepare-services.sh"
AGENT_ARMY_PAPERCLIP_RESTORE=RESTORE_PAPERCLIP_CUTOVER_BACKUP \
  "$repo_root/ops/hybrid-online/cloud/restore-paperclip.sh" \
  RESTORE_PAPERCLIP_CUTOVER_BACKUP \
  "$installed_backup"

archive_sha256="$(sha256sum "$resolved_archive" | awk '{print $1}')"
/usr/local/bin/node -e '
const fs = require("node:fs");
const payload = {
  schemaVersion:"agent.army/cloud-import-complete/v1",
  importedAt:new Date().toISOString(),
  archiveSha256:process.argv[2]
};
fs.writeFileSync(process.argv[1], JSON.stringify(payload, null, 2) + "\n", { mode:0o600 });
' "$allowed_root/import-complete.json" "$archive_sha256"
chown root:agentarmy "$allowed_root/import-complete.json"

echo "云端员工状态已导入并校验；Paperclip 已恢复，A君与三套 Hermes Gateway 仍未启动。"
