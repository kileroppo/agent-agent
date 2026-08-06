#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "主机引导必须由 root 执行。" >&2
  exit 1
fi

umask 077
install -d -m 0700 /var/lib/agent-army
exec > >(tee -a /var/lib/agent-army/bootstrap.log) 2>&1

on_error() {
  touch /var/lib/agent-army/bootstrap-failed
  echo "主机引导失败；业务服务没有启动。" >&2
}
trap on_error ERR

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git gzip jq postgresql-client rsync xz-utils

if ! id agentarmy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/agent-army --shell /usr/sbin/nologin --user-group agentarmy
fi

install -d -o agentarmy -g agentarmy -m 0700 \
  /var/lib/agent-army/private \
  /var/lib/agent-army/hermes/default \
  /var/lib/agent-army/hermes/profiles/ajun \
  /var/lib/agent-army/hermes/profiles/intel-researcher \
  /var/lib/agent-army/hermes/profiles/office-assistant \
  /var/lib/agent-army/.paperclip \
  /opt/agent-army/releases \
  /opt/agent-army/shared/paperclip

HERMES_RELEASE="${HERMES_RELEASE:-v2026.7.7.2}"
HERMES_INSTALL_COMMIT="${HERMES_INSTALL_COMMIT:-9de9c25f620ff7f1ce0fd5457d596052d5159596}"
HERMES_INSTALL_SHA256="${HERMES_INSTALL_SHA256:-a93c65b01ea392e179cf872e182bd01a2b65c0c15f17833e9f9569033ef10e07}"
if ! command -v hermes >/dev/null 2>&1; then
  installer_downloaded=false
  for installer_url in \
    "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_INSTALL_COMMIT}/scripts/install.sh" \
    "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_RELEASE}/scripts/install.sh"; do
    if curl \
      --retry 8 \
      --retry-all-errors \
      --retry-delay 3 \
      --connect-timeout 20 \
      --max-time 180 \
      -fsSL "$installer_url" \
      -o /tmp/hermes-install.sh; then
      actual_sha256="$(sha256sum /tmp/hermes-install.sh | awk '{print $1}')"
      if [[ "$actual_sha256" == "$HERMES_INSTALL_SHA256" ]]; then
        installer_downloaded=true
        break
      fi
      echo "Hermes 安装脚本校验失败，拒绝执行该来源。" >&2
    fi
  done
  if [[ "$installer_downloaded" != "true" ]]; then
    echo "无法下载并校验固定版本的 Hermes 官方安装脚本。" >&2
    exit 1
  fi
  HERMES_HOME=/var/lib/agent-army/hermes/bootstrap \
    bash /tmp/hermes-install.sh --skip-setup --skip-browser --branch "$HERMES_RELEASE"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Hermes 安装后仍缺少 Node.js/npm。" >&2
  exit 1
fi

PAPERCLIP_VERSION="${PAPERCLIP_VERSION:-2026.707.0}"
npm install --prefix /opt/agent-army/shared/paperclip --omit=dev "paperclipai@$PAPERCLIP_VERSION"

chown -R agentarmy:agentarmy /var/lib/agent-army /opt/agent-army
chmod 0700 /var/lib/agent-army /var/lib/agent-army/private /var/lib/agent-army/hermes
touch /var/lib/agent-army/bootstrap-complete
rm -f /var/lib/agent-army/bootstrap-failed
echo "主机引导完成；尚未迁移凭据、任务数据或启动业务入口。"
