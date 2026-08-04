#!/bin/zsh
set -euo pipefail

readonly REPO_ROOT='/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent'
readonly HF_ROOT='/Users/pengaro/.cache/huggingface/hub'
readonly EXPORT_ROOT="$REPO_ROOT/work/local-ai/desktop-model-export/ComfyUI"

link_verified_model() {
  local source_path="$1"
  local destination_path="$2"
  local expected_size="$3"
  local expected_sha="$4"
  test -f "$source_path"
  test "$(stat -f '%z' "$source_path")" = "$expected_size"
  test "$(shasum -a 256 "$source_path" | awk '{print $1}')" = "$expected_sha"
  mkdir -p "$(dirname "$destination_path")"
  if [ -L "$destination_path" ]; then
    test "$(readlink "$destination_path")" = "$source_path"
  elif [ -e "$destination_path" ]; then
    echo "refusing to replace existing non-symlink: $destination_path" >&2
    exit 1
  else
    ln -s "$source_path" "$destination_path"
  fi
}

link_verified_model \
  "$HF_ROOT/models--Comfy-Org--flux2-klein-4B/snapshots/a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246/split_files/text_encoders/qwen_3_4b.safetensors" \
  "$EXPORT_ROOT/models/text_encoders/qwen_3_4b.safetensors" \
  8044982048 \
  6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a

link_verified_model \
  "$HF_ROOT/models--black-forest-labs--FLUX.2-klein-4b-fp8/snapshots/5b4408e59397a4a37ccb46afe426d8ed86379441/flux-2-klein-4b-fp8.safetensors" \
  "$EXPORT_ROOT/models/diffusion_models/flux-2-klein-4b-fp8.safetensors" \
  4070624520 \
  97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6

link_verified_model \
  "$HF_ROOT/models--Comfy-Org--flux2-dev/snapshots/03d6521e6f6a47396b3f951cbea50f7e6c2f482e/split_files/vae/flux2-vae.safetensors" \
  "$EXPORT_ROOT/models/vae/flux2-vae.safetensors" \
  336213556 \
  d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5

(
  cd "$EXPORT_ROOT"
  shasum -a 256 \
    models/text_encoders/qwen_3_4b.safetensors \
    models/diffusion_models/flux-2-klein-4b-fp8.safetensors \
    models/vae/flux2-vae.safetensors > SHA256SUMS
)

printf '%s\n' "desktop model export ready: $EXPORT_ROOT"
printf '%s\n' 'Copy with symlinks dereferenced, for example: rsync -aL <export>/ComfyUI/ <desktop-comfyui>/'
