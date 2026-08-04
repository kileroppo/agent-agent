# 4070 Ti Super 增强节点

这个包运行在另一台装有 RTX 4070 Ti Super 的电脑上，只提供可拔插 GPU 增强，不取代 Mac 主节点。Mac 断开它后仍继续执行全部核心能力。

## 安全与契约

- 服务端口默认 `18083`；监听局域网时必须使用至少 32 字符的 Bearer token，并把来源限制为 Mac 的单个内网 IP。
- Mac 只有在单次请求包含 `approved=true` 时才会发送输入；图片、音频、视频以 Base64 + SHA-256 传输，不发送无法跨机器使用的 Mac 文件路径。
- 台式机产物只能来自本次请求的 output 目录，回传后由 Mac 再验大小和 SHA-256，并保存成 Mac 本地 `artifactPath`。
- 所有 GPU 能力默认共用 `gpu-heavy` 单任务队列，避免 16GB 显存被并发超卖。
- adapter 子进程只继承必要系统变量以及 `COMFYUI_`、`DESKTOP_OPENAI_`、`CUDA_`、`LOCAL_AI_ADAPTER_` 前缀，不继承节点 token 或无关 secret。

## 安装顺序

1. 在台式机安装 NVIDIA 驱动、CUDA 可用的最新版 ComfyUI，并确认 `http://127.0.0.1:8188/system_stats` 能看到 NVIDIA/CUDA。
2. 运行 `python download-desktop-models.py --comfy-root <ComfyUI目录>`。脚本只下载固定 revision 的官方 4B FP8 diffusion、Qwen 4B text encoder 和 FLUX.2 VAE，并逐文件校验固定大小与 SHA-256；不会下载 Base、9B、Z-Image 或视频模型。
3. 从 ComfyUI 官方模板加载 `Flux.2 Klein 4B Text-to-Image` 和 `4B Image Edit Distilled`，各自真实运行一次；官方源地址记录在 `workflows/README.md`。然后分别导出为 **API format**：
   - `workflows/flux2-klein-generate-api.json`
   - `workflows/flux2-klein-edit-api.json`
4. 把工作流里的输入值替换为占位符：`{{PROMPT}}`、`{{NEGATIVE_PROMPT}}`、`{{WIDTH}}`、`{{HEIGHT}}`、`{{STEPS}}`、`{{SEED}}`；编辑工作流的图片加载节点使用 `{{INPUT_IMAGE_0}}`，多参考图依次使用到 `{{INPUT_IMAGE_3}}`。
5. Windows PowerShell 执行 `./install-windows.ps1 -MacPrivateIp <Mac内网IP>`；Linux 执行 `./install-linux.sh <Mac内网IP>`。
6. 安装脚本会生成权限受限的 `desktop-node.env` 和 `mac-pairing.json`。不要把 token 粘贴到聊天、日志或仓库。
7. 先执行安装脚本最后给出的 `--check` 命令。只有两项 ComfyUI 能力均为 healthy，才启动常驻服务和配置 Mac。

安装脚本不会自动下载候选模型、打开公网端口、修改路由器、安装远程控制软件或调用付费服务。

如果三份权重已先下载到 Mac，可在 Mac 执行 `prepare-mac-model-export.sh`，得到 `work/local-ai/desktop-model-export/ComfyUI/`。该目录使用符号链接，不重复占用约 12.45GB 权重；复制到另一台电脑时必须使用 `rsync -aL` 或其他“跟随符号链接”方式，并在目标端复核 `SHA256SUMS`。
