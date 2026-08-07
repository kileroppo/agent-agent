#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/apps/boom-monitor/docker-compose.yml"
MIGRATION_SCRIPT="$REPO_ROOT/apps/ajun-runtime/scripts/migrate-boom-monitor-data.mjs"
LAUNCHD_AUTH_HELPER="$SCRIPT_DIR/update-ajun-launchd-auth.py"
PROJECT_NAME="boom-monitor"
BACKEND_CONTAINER="boom-monitor-backend-1"

usage() {
  printf '%s\n' \
    '用法:' \
    '  docker-lifecycle.sh [status]' \
    '  docker-lifecycle.sh snapshot --output <宿主机 SQLite 路径>' \
    '  docker-lifecycle.sh pause --apply --data-dir <A君数据目录>' \
    '  docker-lifecycle.sh retire --apply --data-dir <A君数据目录>' \
    '  docker-lifecycle.sh restore --apply --data-dir <A君数据目录>' \
    '  docker-lifecycle.sh resume-native --apply --data-dir <A君数据目录> --reconciled' \
    '' \
    '默认只查询状态。pause 仅停止容器；retire 会强一致核验后删除旧容器和网络，但绝不删除数据卷。'
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

require_docker() {
  docker info >/dev/null 2>&1 || {
    printf '%s\n' 'Docker 当前不可用。' >&2
    exit 1
  }
}

status() {
  require_docker
  printf '%s\n' 'Boom Monitor Docker 状态：'
  compose ps
  if docker inspect "$BACKEND_CONTAINER" >/dev/null 2>&1; then
    docker inspect --format '数据挂载: {{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}} {{.Name}} -> {{.Destination}}{{end}}{{end}}' "$BACKEND_CONTAINER"
  fi
  if docker ps --format '{{.Names}}' | grep -Fxq "$BACKEND_CONTAINER"; then
    docker exec "$BACKEND_CONTAINER" python -c 'import json,os,sqlite3,stat; p="/data/boom-monitor.sqlite"; s=os.stat(p); c=sqlite3.connect("file:"+p+"?mode=ro",uri=True); tables=[r[0] for r in c.execute("select name from sqlite_master where type=\"table\" and name not like \"sqlite_%\" order by name")]; print(json.dumps({"database":p,"mode":oct(stat.S_IMODE(s.st_mode)),"rows":{t:c.execute("select count(*) from \""+t+"\"").fetchone()[0] for t in tables},"score_versions":dict(c.execute("select score_version,count(*) from scores group by score_version")),"shadow_versions":dict(c.execute("select version,count(*) from shadow_scores group by version"))},ensure_ascii=False,sort_keys=True)); c.close()'
  else
    printf '%s\n' '后端容器未运行；未读取数据库。'
  fi
}

snapshot_to() {
  local output="$1"
  if [[ -e "$output" ]]; then
    printf '%s\n' '快照目标已存在，拒绝覆盖。' >&2
    return 1
  fi
  mkdir -p -- "$(dirname -- "$output")"
  local output_dir
  output_dir="$(cd -- "$(dirname -- "$output")" && pwd)"
  local output_name
  output_name="$(basename -- "$output")"
  if docker ps --format '{{.Names}}' | grep -Fxq "$BACKEND_CONTAINER"; then
    local container_snapshot="/tmp/boom-monitor-retirement-snapshot-$$.sqlite"
    if ! docker exec "$BACKEND_CONTAINER" python -c 'import os,sqlite3,sys; src=sqlite3.connect("file:/data/boom-monitor.sqlite?mode=ro",uri=True); dst=sqlite3.connect(sys.argv[1]); src.backup(dst); result=dst.execute("pragma quick_check").fetchone()[0]; dst.close(); src.close(); os.chmod(sys.argv[1],0o600); raise SystemExit(0 if result=="ok" else 1)' "$container_snapshot"; then
      docker exec "$BACKEND_CONTAINER" rm -f -- "$container_snapshot" >/dev/null 2>&1 || true
      return 1
    fi
    if ! docker cp "$BACKEND_CONTAINER:$container_snapshot" "$output_dir/$output_name" >/dev/null; then
      docker exec "$BACKEND_CONTAINER" rm -f -- "$container_snapshot" >/dev/null 2>&1 || true
      return 1
    fi
    docker exec "$BACKEND_CONTAINER" rm -f -- "$container_snapshot"
  else
    docker volume inspect boom-monitor_boom_data >/dev/null
    if ! docker run --rm \
      --mount 'type=volume,src=boom-monitor_boom_data,dst=/data,readonly' \
      --mount "type=bind,src=$output_dir,dst=/out" \
      python:3.12-slim \
      python -c 'import os,sqlite3,sys; src=sqlite3.connect("file:/data/boom-monitor.sqlite?mode=ro&immutable=1",uri=True); dst=sqlite3.connect(sys.argv[1]); src.backup(dst); result=dst.execute("pragma quick_check").fetchone()[0]; dst.close(); src.close(); os.chmod(sys.argv[1],0o600); raise SystemExit(0 if result=="ok" else 1)' "/out/$output_name"; then
      rm -f -- "$output_dir/$output_name"
      return 1
    fi
  fi
  chmod 0600 "$output_dir/$output_name"
  sqlite3 "$output_dir/$output_name" 'PRAGMA quick_check;' | grep -Fxq 'ok'
}

verify_migrated_target() {
  local data_dir="$1"
  local temporary_dir
  mkdir -p "$data_dir"
  temporary_dir="$(mktemp -d "$data_dir/.boom-monitor-retirement.XXXXXX")"
  local snapshot="$temporary_dir/live-boom-monitor.sqlite"
  snapshot_to "$snapshot"
  if ! NODE_NO_WARNINGS=1 node "$MIGRATION_SCRIPT" --source "$snapshot" --data-dir "$data_dir" --verify-retirement; then
    rm -rf -- "$temporary_dir"
    return 1
  fi
  rm -rf -- "$temporary_dir"
}

verify_ajun_writer_fenced() {
  local launchd_plist
  launchd_plist="$(ajun_launchd_plist)"
  local configured
  configured="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:AJUN_BOOM_MONITOR_ENABLED' "$launchd_plist" 2>/dev/null || true)"
  [[ "$configured" == 'false' ]] || {
    printf '%s\n' 'A君 launchd 尚未配置 AJUN_BOOM_MONITOR_ENABLED=false；请先通过正式运行配置关闭 native writer 并重启 A君。' >&2
    return 1
  }
  wait_for_ajun_health 503 || {
    printf '%s\n' 'A君 Boom Monitor health 不是禁用态 503；拒绝启动第二个 writer。' >&2
    return 1
  }
}

ajun_launchd_plist() {
  local current_user
  current_user="$(id -un)"
  local user_home
  user_home="$(dscl . -read "/Users/$current_user" NFSHomeDirectory 2>/dev/null | awk 'NR == 1 { print $2 }')"
  [[ -n "$user_home" ]] || { printf '%s\n' '无法定位当前用户主目录，拒绝恢复 Docker。' >&2; return 1; }
  local launchd_plist="$user_home/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist"
  [[ -f "$launchd_plist" ]] || { printf '%s\n' '找不到当前 A君 launchd plist，拒绝恢复 Docker。' >&2; return 1; }
  printf '%s\n' "$launchd_plist"
}

wait_for_ajun_health() {
  local expected="$1"
  local status_code
  for _ in {1..30}; do
    status_code="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:4321/api/boom-monitor/health || true)"
    [[ "$status_code" == "$expected" ]] && return 0
    sleep 1
  done
  return 1
}

reload_ajun_launchd() {
  local launchd_plist="$1"
  local domain="gui/$(id -u)"
  local label='ai.agent-army.ajun-runtime'
  env -u BOOM_MONITOR_BEARER_TOKEN launchctl bootout "$domain/$label" >/dev/null 2>&1 \
    || env -u BOOM_MONITOR_BEARER_TOKEN launchctl unload "$launchd_plist" >/dev/null 2>&1 \
    || true
  if ! env -u BOOM_MONITOR_BEARER_TOKEN launchctl bootstrap "$domain" "$launchd_plist" >/dev/null 2>&1; then
    env -u BOOM_MONITOR_BEARER_TOKEN launchctl load -w "$launchd_plist" >/dev/null
  fi
}

configure_rollback_auth_and_restart() {
  local launchd_plist
  launchd_plist="$(ajun_launchd_plist)"
  printf '%s' "$BOOM_MONITOR_BEARER_TOKEN" \
    | env -u BOOM_MONITOR_BEARER_TOKEN python3 "$LAUNCHD_AUTH_HELPER" rollback "$launchd_plist"
  reload_ajun_launchd "$launchd_plist"
  wait_for_ajun_health 503 || { printf '%s\n' 'A君 重启后没有进入 native 禁用态 503。' >&2; return 1; }
  printf '%s' "$BOOM_MONITOR_BEARER_TOKEN" \
    | env -u BOOM_MONITOR_BEARER_TOKEN python3 "$LAUNCHD_AUTH_HELPER" verify-rollback "$launchd_plist"
  verify_legacy_bridge_auth
}

verify_legacy_bridge_auth() {
  printf '%s' "$BOOM_MONITOR_BEARER_TOKEN" \
    | env -u BOOM_MONITOR_BEARER_TOKEN python3 -c 'import sys; value=sys.stdin.read(); sys.stdout.write(("A" if value[:1] != "A" else "B") + value[1:])' \
    | legacy_bridge_probe 401
  printf '%s' "$BOOM_MONITOR_BEARER_TOKEN" | legacy_bridge_probe 200
}

legacy_bridge_probe() {
  local expected="$1"
  env -u BOOM_MONITOR_BEARER_TOKEN docker run --rm -i \
    --add-host 'host.docker.internal:host-gateway' \
    python:3.12-slim \
    python -c 'import sys,urllib.error,urllib.request; token=sys.stdin.read(); request=urllib.request.Request("http://host.docker.internal:4321/api/integrations/boom-monitor/health",headers={"Authorization":"Bearer "+token}); status=0
try:
  response=urllib.request.urlopen(request,timeout=5); status=response.status; response.close()
except urllib.error.HTTPError as error:
  status=error.code
except Exception:
  status=0
raise SystemExit(0 if status==int(sys.argv[1]) else 1)' "$expected" >/dev/null
}

preserve_ajun_database_read_only() {
  local data_dir="$1"
  local target="$data_dir/boom-monitor.sqlite"
  [[ -f "$target" && -s "$target" ]] || { printf '%s\n' 'A君 boom-monitor.sqlite 不存在或为空，拒绝恢复。' >&2; return 1; }
  sqlite3 "$target" 'PRAGMA quick_check;' | grep -Fxq 'ok'
  chmod 0400 "$target"
  [[ "$(stat -f '%Lp' "$target")" == '400' ]] || { printf '%s\n' 'A君 boom-monitor.sqlite 未能收紧为 0400。' >&2; return 1; }
}

command="${1:-status}"
case "$command" in
  status)
    [[ $# -le 1 ]] || { usage >&2; exit 2; }
    status
    ;;
  snapshot)
    require_docker
    [[ "${2:-}" == '--output' && -n "${3:-}" && $# -eq 3 ]] || { usage >&2; exit 2; }
    snapshot_to "$3"
    printf '一致性快照已创建（0600）: %s\n' "$3"
    ;;
  pause)
    require_docker
    [[ "${2:-}" == '--apply' && "${3:-}" == '--data-dir' && -n "${4:-}" && $# -eq 4 ]] || { usage >&2; exit 2; }
    verify_migrated_target "$4"
    compose stop
    verify_migrated_target "$4"
    printf '%s\n' 'Boom Monitor Docker 已暂停；容器和 boom-monitor_boom_data 卷均保留。'
    ;;
  retire)
    require_docker
    [[ "${2:-}" == '--apply' && "${3:-}" == '--data-dir' && -n "${4:-}" && $# -eq 4 ]] || { usage >&2; exit 2; }
    verify_migrated_target "$4"
    docker volume inspect boom-monitor_boom_data >/dev/null
    compose stop
    verify_migrated_target "$4"
    compose down --remove-orphans
    docker volume inspect boom-monitor_boom_data >/dev/null
    printf '%s\n' 'Boom Monitor 旧容器和网络已删除；boom-monitor_boom_data 卷仍保留。没有执行 down -v。'
    ;;
  restore)
    require_docker
    [[ "${2:-}" == '--apply' && "${3:-}" == '--data-dir' && -n "${4:-}" && $# -eq 4 ]] || { usage >&2; exit 2; }
    [[ -z "$(compose ps --status running -q)" ]] || { printf '%s\n' 'Boom Monitor Docker 已在运行，不执行 restore。' >&2; exit 1; }
    if [[ -z "${BOOM_MONITOR_BEARER_TOKEN:-}" ]]; then
      printf '%s\n' '恢复会重建容器；请先从受控凭据存储向当前 shell 注入新的 BOOM_MONITOR_BEARER_TOKEN（脚本不会读取或输出它）。' >&2
      exit 1
    fi
    verify_ajun_writer_fenced
    verify_migrated_target "$4"
    configure_rollback_auth_and_restart
    preserve_ajun_database_read_only "$4"
    compose up -d
    health_url="http://127.0.0.1:${BOOM_HTTP_PORT:-8081}/api/health"
    healthy='false'
    for _ in {1..30}; do
      if curl --fail --silent --show-error "$health_url" >/dev/null 2>&1; then
        healthy='true'
        break
      fi
      sleep 1
    done
    [[ "$healthy" == 'true' ]] || { printf '%s\n' '容器已重建，但健康检查未在 30 秒内通过。' >&2; exit 1; }
    status
    ;;
  resume-native)
    require_docker
    [[ "${2:-}" == '--apply' && "${3:-}" == '--data-dir' && -n "${4:-}" && "${5:-}" == '--reconciled' && $# -eq 5 ]] || { usage >&2; exit 2; }
    [[ -z "$(compose ps --status running -q)" ]] || { printf '%s\n' '请先停止旧 Docker writer，再恢复 native。' >&2; exit 1; }
    native_target="$4/boom-monitor.sqlite"
    [[ -f "$native_target" && -s "$native_target" ]] || { printf '%s\n' 'A君 boom-monitor.sqlite 不存在或为空。' >&2; exit 1; }
    sqlite3 "$native_target" 'PRAGMA quick_check;' | grep -Fxq 'ok'
    chmod 0600 "$native_target"
    native_plist="$(ajun_launchd_plist)"
    env -u BOOM_MONITOR_BEARER_TOKEN python3 "$LAUNCHD_AUTH_HELPER" native "$native_plist"
    reload_ajun_launchd "$native_plist"
    wait_for_ajun_health 200 || { printf '%s\n' 'A君 native 重启后健康检查未在 30 秒内返回 200。' >&2; exit 1; }
    env -u BOOM_MONITOR_BEARER_TOKEN python3 "$LAUNCHD_AUTH_HELPER" verify-native "$native_plist"
    printf '%s\n' 'A君 native writer 已恢复；launchd 中的回滚 Token 已删除。'
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
