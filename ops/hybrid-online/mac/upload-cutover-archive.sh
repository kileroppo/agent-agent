#!/usr/bin/env bash
set -euo pipefail

required_confirmation="TRANSFER_PRIVATE_CUTOVER_ARCHIVE"
apply=false
confirmation=""
archive=""
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --confirm=*) confirmation="${arg#--confirm=}" ;;
    --archive=*) archive="${arg#--archive=}" ;;
    *) echo "无法识别参数；默认只输出计划。" >&2; exit 1 ;;
  esac
done

if [[ "$apply" != "true" ]]; then
  echo "迁移归档上传预览"
  echo "- 仅接受老板 Mac 私有 cutover 目录中的明确归档"
  echo "- 上传前在隔离临时目录重新校验全部文件 SHA-256"
  echo "- 仅通过 Google IAP SSH 传输到云端受控目录"
  echo "- 上传不会导入状态、启动服务或接管飞书"
  exit 0
fi

if [[ "$confirmation" != "$required_confirmation" ]] || \
   [[ "${AGENT_ARMY_CUTOVER_TRANSFER:-}" != "$required_confirmation" ]]; then
  echo "迁移上传需要命令确认词和独立环境门禁。" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
manifest_tool="$repo_root/ops/hybrid-online/cutover/manifest.mjs"
private_env="${AGENT_ARMY_MAC_WORKER_ENV:-$HOME/.agent-army/mac-worker.env}"
allowed_root="$HOME/.agent-army/cutover"
resolved_archive="$(realpath "$archive" 2>/dev/null || true)"
if [[ -z "$resolved_archive" ]] || [[ "$resolved_archive" != "$allowed_root/"* ]] || \
   [[ ! -f "$resolved_archive" ]] || [[ ! "$(basename "$resolved_archive")" =~ ^agent-army-cutover-([0-9]{8}T[0-9]{6}Z)\.tar\.gz\.gpg$ ]]; then
  echo "只允许上传本机受控 cutover 目录中的明确归档。" >&2
  exit 1
fi
timestamp="${BASH_REMATCH[1]}"
keychain_service="agent-army-cutover-$timestamp"
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
for required_command in gpg security shasum tar; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "缺少迁移上传必需命令：$required_command" >&2
    exit 1
  fi
done

verification_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-army-cutover-verify.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -rf "$verification_root"
  exit "$status"
}
trap cleanup EXIT INT TERM

passphrase="$(security find-generic-password -a "$USER" -s "$keychain_service" -w 2>/dev/null || true)"
if [[ -z "$passphrase" ]]; then
  echo "找不到迁移归档对应的 macOS 钥匙串密码。" >&2
  exit 1
fi
plain_archive="$verification_root/agent-army-cutover-$timestamp.tar.gz"
if ! printf '%s' "$passphrase" | gpg \
  --batch \
  --yes \
  --pinentry-mode loopback \
  --passphrase-fd 0 \
  --decrypt \
  --output "$plain_archive" \
  "$resolved_archive" >/dev/null 2>&1; then
  unset passphrase
  echo "迁移归档解密失败。" >&2
  exit 1
fi
unset passphrase

if tar -tzf "$plain_archive" | sed 's#^\./##' | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "迁移归档含不安全路径。" >&2
  exit 1
fi
if tar -tvzf "$plain_archive" | awk '$1 ~ /^[lh]/ { found=1 } END { exit found ? 0 : 1 }'; then
  echo "迁移归档不允许符号链接或硬链接。" >&2
  exit 1
fi
tar -xzf "$plain_archive" -C "$verification_root"
node "$manifest_tool" verify "$verification_root" >/dev/null

archive_name="$(basename "$plain_archive")"
archive_sha256="$(shasum -a 256 "$plain_archive" | awk '{print $1}')"
"$gcloud_bin" compute scp "$plain_archive" \
  "$AGENT_ARMY_GCP_INSTANCE:/tmp/$archive_name" \
  "--project=$AGENT_ARMY_GCP_PROJECT" \
  "--zone=$AGENT_ARMY_GCP_ZONE" \
  --tunnel-through-iap \
  --quiet

remote_command="set -euo pipefail; sudo test -f /var/lib/agent-army/bootstrap-complete; test \"\$(sha256sum /tmp/$archive_name | awk '{print \$1}')\" = '$archive_sha256'; sudo install -d -o root -g agentarmy -m 0700 /var/lib/agent-army/private/cutover; sudo install -o root -g agentarmy -m 0600 /tmp/$archive_name /var/lib/agent-army/private/cutover/$archive_name; rm -f /tmp/$archive_name"
"$gcloud_bin" compute ssh "$AGENT_ARMY_GCP_INSTANCE" \
  "--project=$AGENT_ARMY_GCP_PROJECT" \
  "--zone=$AGENT_ARMY_GCP_ZONE" \
  --tunnel-through-iap \
  --quiet \
  "--command=$remote_command"

echo "迁移归档已通过 IAP 上传并校验；尚未导入、启动或接管飞书。"
echo "云端归档：/var/lib/agent-army/private/cutover/$archive_name"
