#!/usr/bin/env bash
set -euo pipefail

required_confirmation="PREPARE_PRIVATE_CUTOVER_ARCHIVE"
apply=false
confirmation=""
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --confirm=*) confirmation="${arg#--confirm=}" ;;
    *) echo "无法识别参数；默认只输出计划。" >&2; exit 1 ;;
  esac
done

if [[ "$apply" != "true" ]]; then
  echo "员工云端迁移归档预览"
  echo "- 停止本机 A君 与三套 Hermes Gateway，阻止迁移期间继续写入"
  echo "- 使用 Paperclip 官方 db:backup 生成单个可移植 SQL 备份"
  echo "- 归档 A君任务、员工 Profile/Session/Memory、飞书私有配置和 Paperclip 加密状态"
  echo "- 排除日志、PID、锁、缓存、请求转储、Hermes 程序代码和 Paperclip 原始数据库目录"
  echo "- 文件逐一记录 SHA-256；失败自动恢复本机全部服务"
  echo "- 真正执行需要 --apply、确认词和独立环境门禁"
  exit 0
fi

if [[ "$confirmation" != "$required_confirmation" ]] || \
   [[ "${AGENT_ARMY_CUTOVER_ARCHIVE:-}" != "$required_confirmation" ]]; then
  echo "迁移归档需要命令确认词和独立环境门禁。" >&2
  exit 1
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "本机迁移归档只能在老板 Mac 上执行。" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
manifest_tool="$repo_root/ops/hybrid-online/cutover/manifest.mjs"
uid="$(id -u)"
service_domain="gui/$uid"
launch_agents="$HOME/Library/LaunchAgents"
cutover_root="$HOME/.agent-army/cutover"
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
staging="$(mktemp -d "${TMPDIR:-/tmp}/agent-army-cutover.XXXXXX")"
plain_archive="$staging/agent-army-cutover-$timestamp.tar.gz"
archive_tmp="$staging/agent-army-cutover-$timestamp.tar.gz.gpg"
archive="$cutover_root/agent-army-cutover-$timestamp.tar.gz.gpg"
keychain_service="agent-army-cutover-$timestamp"
keychain_created=false
rollback_needed=true

services=(
  "ai.agent-army.ajun-runtime|$launch_agents/ai.agent-army.ajun-runtime.plist"
  "ai.hermes.gateway|$launch_agents/ai.hermes.gateway.plist"
  "ai.hermes.gateway-intel-researcher|$launch_agents/ai.hermes.gateway-intel-researcher.plist"
  "ai.hermes.gateway-office-assistant|$launch_agents/ai.hermes.gateway-office-assistant.plist"
  "ai.agent-army.paperclip|$launch_agents/ai.agent-army.paperclip.plist"
)

for required_command in gpg openssl plutil rsync security shasum tar; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "缺少迁移归档必需命令：$required_command" >&2
    exit 1
  fi
done

service_is_running() {
  local label="$1"
  launchctl print "$service_domain/$label" 2>/dev/null | grep -q 'state = running'
}

start_service() {
  local label="$1"
  local plist="$2"
  if service_is_running "$label"; then return; fi
  launchctl bootstrap "$service_domain" "$plist" >/dev/null 2>&1 || true
  launchctl enable "$service_domain/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "$service_domain/$label" >/dev/null 2>&1 || true
}

restore_local_services() {
  local entry label plist
  for entry in \
    "ai.agent-army.paperclip|$launch_agents/ai.agent-army.paperclip.plist" \
    "ai.agent-army.ajun-runtime|$launch_agents/ai.agent-army.ajun-runtime.plist" \
    "ai.hermes.gateway|$launch_agents/ai.hermes.gateway.plist" \
    "ai.hermes.gateway-intel-researcher|$launch_agents/ai.hermes.gateway-intel-researcher.plist" \
    "ai.hermes.gateway-office-assistant|$launch_agents/ai.hermes.gateway-office-assistant.plist"; do
    label="${entry%%|*}"
    plist="${entry#*|}"
    start_service "$label" "$plist"
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -rf "$staging"
  if [[ "$status" -ne 0 && "$keychain_created" == "true" ]]; then
    security delete-generic-password -a "$USER" -s "$keychain_service" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -ne 0 && "$rollback_needed" == "true" ]]; then
    restore_local_services
    echo "迁移归档失败；本机员工入口已尝试恢复。" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

for entry in "${services[@]}"; do
  label="${entry%%|*}"
  plist="${entry#*|}"
  if [[ ! -f "$plist" ]]; then
    echo "缺少本机服务定义，拒绝切换：$label" >&2
    exit 1
  fi
  if ! service_is_running "$label"; then
    echo "本机服务未处于运行状态，拒绝在状态不明时切换：$label" >&2
    exit 1
  fi
done

for label in \
  ai.agent-army.ajun-runtime \
  ai.hermes.gateway \
  ai.hermes.gateway-intel-researcher \
  ai.hermes.gateway-office-assistant; do
  launchctl bootout "$service_domain/$label"
done

mkdir -p "$staging/paperclip/backups"
paperclip_plist="$launch_agents/ai.agent-army.paperclip.plist"
paperclip_node="$(plutil -extract ProgramArguments.0 raw -o - "$paperclip_plist")"
paperclip_cli="$(plutil -extract ProgramArguments.1 raw -o - "$paperclip_plist")"
"$paperclip_node" "$paperclip_cli" db:backup \
  --config "$HOME/.paperclip/instances/default/config.json" \
  --dir "$staging/paperclip/backups" \
  --retention-days 1 \
  --filename-prefix cutover \
  --json >/dev/null

mapfile_supported=false
if help mapfile >/dev/null 2>&1; then mapfile_supported=true; fi
if [[ "$mapfile_supported" == "true" ]]; then
  mapfile -t paperclip_backups < <(find "$staging/paperclip/backups" -type f -name '*.sql.gz')
  backup_count="${#paperclip_backups[@]}"
else
  backup_count="$(find "$staging/paperclip/backups" -type f -name '*.sql.gz' | wc -l | tr -d ' ')"
fi
if [[ "$backup_count" != "1" ]]; then
  echo "Paperclip 官方备份数量不正确。" >&2
  exit 1
fi
launchctl bootout "$service_domain/ai.agent-army.paperclip"

copy_profile() {
  local source="$1"
  local target="$2"
  mkdir -p "$target"
  rsync -a \
    --exclude 'hermes-agent/' \
    --exclude 'profiles/' \
    --exclude 'bin/' \
    --exclude 'logs/' \
    --exclude 'cache/' \
    --exclude 'bootstrap-cache/' \
    --exclude 'node_modules/' \
    --exclude 'gateway.pid' \
    --exclude 'gateway.lock' \
    --exclude 'gateway_state.json' \
    --exclude 'gateway-starts.log' \
    --exclude '*.lock' \
    --exclude '*.db-wal' \
    --exclude '*.db-shm' \
    --exclude '.update*' \
    --exclude 'state/gateway.heartbeat' \
    --exclude 'sessions/request_dump_*.json' \
    "$source/" "$target/"
}

copy_profile "$HOME/.hermes" "$staging/hermes/default"
copy_profile "$HOME/.hermes/profiles/ajun" "$staging/hermes/profiles/ajun"
copy_profile "$HOME/.hermes/profiles/intel-researcher" "$staging/hermes/profiles/intel-researcher"
copy_profile "$HOME/.hermes/profiles/office-assistant" "$staging/hermes/profiles/office-assistant"

mkdir -p "$staging/agent-army" "$staging/private" "$staging/paperclip/instance/secrets" "$staging/proof"
rsync -a \
  --exclude '*.log' \
  --exclude 'lan-share-key' \
  "$repo_root/apps/ajun-runtime/data/" "$staging/agent-army/"
install -m 0600 "$HOME/.agent-army/feishu-agent-apps.json" "$staging/private/feishu-agent-apps.json"
install -m 0600 "$HOME/.agent-army/feishu-agent-secrets.json" "$staging/private/feishu-agent-secrets.json"

paperclip_instance="$HOME/.paperclip/instances/default"
install -m 0600 "$paperclip_instance/.env" "$staging/paperclip/instance/.env"
install -m 0600 "$paperclip_instance/config.json" "$staging/paperclip/instance/config.json"
install -m 0600 "$paperclip_instance/secrets/master.key" "$staging/paperclip/instance/secrets/master.key"
if [[ -d "$paperclip_instance/data/storage" ]]; then
  mkdir -p "$staging/paperclip/instance/data/storage"
  rsync -a "$paperclip_instance/data/storage/" "$staging/paperclip/instance/data/storage/"
fi

git_head="$(git -C "$repo_root" rev-parse HEAD)"
git_branch="$(git -C "$repo_root" branch --show-current)"
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const payload = {
  schemaVersion:"agent.army/local-services-stopped/v1",
  createdAt:new Date().toISOString(),
  gitHead:process.argv[2],
  services:process.argv.slice(3)
};
fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", { mode:0o600 });
' "$staging/proof/local-services-stopped.json" "$git_head" \
  ai.agent-army.ajun-runtime \
  ai.agent-army.paperclip \
  ai.hermes.gateway \
  ai.hermes.gateway-intel-researcher \
  ai.hermes.gateway-office-assistant

node "$manifest_tool" write "$staging" "$git_head" "$git_branch" >/dev/null
mkdir -p "$cutover_root"
chmod 0700 "$cutover_root"
tar -czf "$plain_archive" \
  --exclude "./$(basename "$plain_archive")" \
  --exclude "./$(basename "$archive_tmp")" \
  -C "$staging" .
passphrase="$(openssl rand -hex 32)"
security add-generic-password -a "$USER" -s "$keychain_service" -w "$passphrase" -U >/dev/null
keychain_created=true
printf '%s' "$passphrase" | gpg \
  --batch \
  --yes \
  --pinentry-mode loopback \
  --passphrase-fd 0 \
  --symmetric \
  --cipher-algo AES256 \
  --s2k-digest-algo SHA512 \
  --output "$archive_tmp" \
  "$plain_archive"
unset passphrase
chmod 0600 "$archive_tmp"
mv "$archive_tmp" "$archive"
archive_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
rollback_needed=false
echo "迁移归档已创建；本机员工入口保持停止，等待安全上传或显式回退。"
echo "归档：$archive"
echo "SHA-256：$archive_sha256"
