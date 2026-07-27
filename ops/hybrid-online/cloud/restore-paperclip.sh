#!/usr/bin/env bash
set -euo pipefail

confirmation="${1:-}"
backup_file="${2:-}"
required_confirmation="RESTORE_PAPERCLIP_CUTOVER_BACKUP"

if [[ "$(id -u)" != "0" ]]; then
  echo "Paperclip 恢复必须由 root 执行。" >&2
  exit 1
fi
if [[ "$confirmation" != "$required_confirmation" ]] || \
   [[ "${AGENT_ARMY_PAPERCLIP_RESTORE:-}" != "$required_confirmation" ]]; then
  echo "Paperclip 恢复需要命令确认词和独立环境门禁。" >&2
  exit 1
fi

allowed_root="/var/lib/agent-army/private/cutover"
resolved_backup="$(realpath "$backup_file" 2>/dev/null || true)"
if [[ -z "$resolved_backup" ]] || [[ "$resolved_backup" != "$allowed_root/"* ]] || [[ ! -f "$resolved_backup" ]]; then
  echo "只允许恢复受控 cutover 目录中的明确备份文件。" >&2
  exit 1
fi
if [[ "$resolved_backup" != *.sql.gz ]]; then
  echo "Paperclip 备份必须是官方 db:backup 生成的 .sql.gz 文件。" >&2
  exit 1
fi
if systemctl is-active --quiet agent-army-ajun-cloud.service; then
  echo "恢复 Paperclip 前必须保持 A君云端运行时停止。" >&2
  exit 1
fi

systemctl start agent-army-paperclip.service
ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:3100/api/health >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  systemctl stop agent-army-paperclip.service
  echo "Paperclip 空实例未能就绪，未执行数据库恢复。" >&2
  exit 1
fi

if ! gzip -dc "$resolved_backup" | \
  PGPASSWORD=paperclip psql \
    --dbname=postgres://paperclip@127.0.0.1:54329/paperclip \
    --set=ON_ERROR_STOP=1 \
    --quiet \
    --no-psqlrc; then
  systemctl stop agent-army-paperclip.service
  echo "Paperclip 恢复失败；服务已停止并保留诊断现场。" >&2
  exit 1
fi

systemctl restart agent-army-paperclip.service
for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:3100/api/health >/dev/null 2>&1; then
    echo "Paperclip 官方 SQL 备份已恢复；A君与 Hermes Gateway 仍未启动。"
    exit 0
  fi
  sleep 1
done

systemctl stop agent-army-paperclip.service
echo "Paperclip 恢复后健康检查失败；服务已停止并保留诊断现场。" >&2
exit 1
