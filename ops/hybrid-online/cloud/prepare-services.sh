#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "云端服务准备必须由 root 执行。" >&2
  exit 1
fi

repo_root="/opt/agent-army/current"
data_root="/var/lib/agent-army"
cloud_env="/etc/agent-army/cloud.env"
service_user="agentarmy"

required_files=(
  "/var/lib/agent-army/bootstrap-complete"
  "$repo_root/apps/ajun-runtime/src/server.ts"
  "$repo_root/apps/ajun-runtime/src/agent-army-mcp-server.js"
  "$repo_root/ops/hybrid-online/preflight.mjs"
  "$cloud_env"
  "$data_root/hermes/default/config.yaml"
  "$data_root/hermes/default/state.db"
  "$data_root/hermes/profiles/ajun/config.yaml"
  "$data_root/hermes/profiles/intel-researcher/config.yaml"
  "$data_root/hermes/profiles/intel-researcher/state.db"
  "$data_root/hermes/profiles/office-assistant/config.yaml"
  "$data_root/hermes/profiles/office-assistant/state.db"
  "$data_root/.paperclip/instances/default/.env"
  "$data_root/.paperclip/instances/default/config.json"
  "$data_root/.paperclip/instances/default/secrets/master.key"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "缺少云端准备文件，拒绝安装服务：$required_file" >&2
    exit 1
  fi
done

if [[ "$(stat -c '%a' "$cloud_env")" != "600" ]]; then
  echo "云端私有配置权限必须为 600。" >&2
  exit 1
fi

rewrite_profile_paths() {
  local config_file="$1"
  sed -i -E \
    -e 's#command: /Users/[^/]+/\.local/bin/node#command: /usr/local/bin/node#' \
    -e 's#- /Users/[^/]+/.*/apps/ajun-runtime/src/agent-army-mcp-server\.js#- /opt/agent-army/current/apps/ajun-runtime/src/agent-army-mcp-server.js#' \
    "$config_file"
  if grep -qE '/Users/[^/]+/.*/agent-army-mcp-server\.js|command: /Users/[^/]+/\.local/bin/node' "$config_file"; then
    echo "Hermes Profile 仍含本机 MCP 路径，拒绝继续。" >&2
    exit 1
  fi
}

rewrite_profile_paths "$data_root/hermes/default/config.yaml"
rewrite_profile_paths "$data_root/hermes/profiles/intel-researcher/config.yaml"
rewrite_profile_paths "$data_root/hermes/profiles/office-assistant/config.yaml"

paperclip_instance="$data_root/.paperclip/instances/default"
paperclip_config_tmp="$(mktemp)"
trap 'rm -f "$paperclip_config_tmp"' EXIT
jq \
  --arg root "$paperclip_instance" \
  '
    .database.mode = "embedded-postgres" |
    .database.embeddedPostgresDataDir = ($root + "/db") |
    .database.embeddedPostgresPort = 54329 |
    .database.backup.dir = ($root + "/data/backups") |
    .logging.logDir = ($root + "/logs") |
    .server.deploymentMode = "local_trusted" |
    .server.exposure = "private" |
    .server.bind = "loopback" |
    .server.host = "127.0.0.1" |
    .server.port = 3100 |
    .storage.localDisk.baseDir = ($root + "/data/storage") |
    .secrets.localEncrypted.keyFilePath = ($root + "/secrets/master.key")
  ' \
  "$paperclip_instance/config.json" > "$paperclip_config_tmp"
install -o "$service_user" -g "$service_user" -m 0600 \
  "$paperclip_config_tmp" "$paperclip_instance/config.json"

chown -R "$service_user:$service_user" "$data_root" /opt/agent-army
chmod 0700 "$data_root" "$data_root/private" "$data_root/hermes"
chmod 0600 "$cloud_env"

/usr/local/bin/node "$repo_root/ops/hybrid-online/preflight.mjs" cloud "$cloud_env"

install -o root -g root -m 0644 \
  "$repo_root/ops/hybrid-online/cloud/agent-army-paperclip.service" \
  /etc/systemd/system/agent-army-paperclip.service
install -o root -g root -m 0644 \
  "$repo_root/ops/hybrid-online/cloud/agent-army-ajun-cloud.service" \
  /etc/systemd/system/agent-army-ajun-cloud.service

profiles=(
  "$data_root/hermes/default"
  "$data_root/hermes/profiles/intel-researcher"
  "$data_root/hermes/profiles/office-assistant"
)
for profile_home in "${profiles[@]}"; do
  HERMES_HOME="$profile_home" /usr/local/bin/hermes gateway install \
    --system \
    --run-as-user "$service_user" \
    --force \
    --no-start-now \
    --no-start-on-login
done

expected_units=(
  "hermes-gateway.service"
  "hermes-gateway-intel-researcher.service"
  "hermes-gateway-office-assistant.service"
)
for expected_unit in "${expected_units[@]}"; do
  if [[ ! -f "/etc/systemd/system/$expected_unit" ]]; then
    echo "Hermes 未生成预期服务：$expected_unit" >&2
    exit 1
  fi
done

systemctl daemon-reload
echo "云端服务已准备但未启用、未启动，也未接管任何飞书入口。"
