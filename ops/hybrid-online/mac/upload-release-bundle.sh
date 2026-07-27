#!/usr/bin/env bash
set -euo pipefail

required_confirmation="TRANSFER_COMMITTED_CLOUD_RELEASE"
apply=false
confirmation=""
release_branch=""
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --confirm=*) confirmation="${arg#--confirm=}" ;;
    --branch=*) release_branch="${arg#--branch=}" ;;
    *) echo "无法识别参数；默认只输出计划。" >&2; exit 1 ;;
  esac
done

if [[ "$apply" != "true" ]]; then
  echo "云端代码版本上传预览"
  echo "- 只接受 codex/ 前缀的本地 Git 分支"
  echo "- 分支必须对应一个完全干净的独立工作树"
  echo "- 生成并校验 Git bundle，通过 IAP 上传固定提交"
  echo "- 云端以只读发布目录安装并原子切换 current 符号链接"
  echo "- 不上传当前脏工作树，不启动任何服务"
  exit 0
fi

if [[ "$confirmation" != "$required_confirmation" ]] || \
   [[ "${AGENT_ARMY_RELEASE_TRANSFER:-}" != "$required_confirmation" ]]; then
  echo "代码版本上传需要命令确认词和独立环境门禁。" >&2
  exit 1
fi
if [[ ! "$release_branch" =~ ^codex/[A-Za-z0-9._/-]+$ ]] || [[ "$release_branch" == *..* ]]; then
  echo "云端发布分支必须使用安全的 codex/ 前缀。" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
private_env="${AGENT_ARMY_MAC_WORKER_ENV:-$HOME/.agent-army/mac-worker.env}"
if [[ ! -f "$private_env" ]]; then
  echo "Mac工作间私有配置不存在。" >&2
  exit 1
fi
set -a
source "$private_env"
set +a

release_ref="refs/heads/$release_branch"
release_sha="$(git -C "$repo_root" rev-parse --verify "$release_ref^{commit}" 2>/dev/null || true)"
if [[ ! "$release_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo "找不到明确的云端发布提交。" >&2
  exit 1
fi
release_worktree="$(git -C "$repo_root" worktree list --porcelain | awk -v wanted="branch $release_ref" '
  /^worktree / { candidate=substr($0, 10) }
  $0 == wanted { print candidate; exit }
')"
if [[ -z "$release_worktree" ]] || [[ ! -d "$release_worktree" ]]; then
  echo "发布分支必须保留一个可核对的独立工作树。" >&2
  exit 1
fi
if [[ -n "$(git -C "$release_worktree" status --porcelain)" ]]; then
  echo "发布工作树不干净，拒绝生成云端版本。" >&2
  exit 1
fi
if git -C "$release_worktree" ls-tree -r --name-only "$release_sha" | \
  grep -Eq '(^|/)(\.env|auth\.json|feishu-agent-secrets\.json|master\.key)$'; then
  echo "发布提交包含禁止进入 Git 的私有文件。" >&2
  exit 1
fi

cutover_root="$HOME/.agent-army/cutover"
mkdir -p "$cutover_root"
chmod 0700 "$cutover_root"
bundle="$cutover_root/agent-army-release-$release_sha.bundle"
git -C "$repo_root" bundle create "$bundle" "$release_ref"
git -C "$repo_root" bundle verify "$bundle" >/dev/null
chmod 0600 "$bundle"

gcloud_bin="${AGENT_ARMY_GCLOUD_BIN:-}"
bundle_name="$(basename "$bundle")"
bundle_sha256="$(shasum -a 256 "$bundle" | awk '{print $1}')"
"$gcloud_bin" compute scp "$bundle" \
  "$AGENT_ARMY_GCP_INSTANCE:/tmp/$bundle_name" \
  "--project=$AGENT_ARMY_GCP_PROJECT" \
  "--zone=$AGENT_ARMY_GCP_ZONE" \
  --tunnel-through-iap \
  --quiet

remote_command="set -euo pipefail; test \"\$(sha256sum /tmp/$bundle_name | awk '{print \$1}')\" = '$bundle_sha256'; sudo test ! -e /opt/agent-army/current -o -L /opt/agent-army/current; sudo test ! -e /opt/agent-army/releases/$release_sha; sudo git clone --quiet --no-checkout /tmp/$bundle_name /opt/agent-army/releases/$release_sha; sudo git -C /opt/agent-army/releases/$release_sha checkout --quiet --detach $release_sha; test \"\$(sudo git -C /opt/agent-army/releases/$release_sha rev-parse HEAD)\" = '$release_sha'; sudo chown -R root:agentarmy /opt/agent-army/releases/$release_sha; sudo chmod -R go-w /opt/agent-army/releases/$release_sha; sudo ln -sfn /opt/agent-army/releases/$release_sha /opt/agent-army/current; rm -f /tmp/$bundle_name"
"$gcloud_bin" compute ssh "$AGENT_ARMY_GCP_INSTANCE" \
  "--project=$AGENT_ARMY_GCP_PROJECT" \
  "--zone=$AGENT_ARMY_GCP_ZONE" \
  --tunnel-through-iap \
  --quiet \
  "--command=$remote_command"

echo "已通过 IAP 安装固定云端代码版本：$release_sha"
echo "尚未迁移私有状态，也未启动任何员工入口。"
