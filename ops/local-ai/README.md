# 本地 AI 运行服务

本目录只托管本机模型适配与资源互斥，不创建业务任务、审批、预算或审计真相；这些仍由 A君与 Paperclip 负责。

- `18081`：Qwen3.5-9B MLX-VLM，文本、单/多图与视频抽帧理解。
- `18082`：统一能力网关；Embedding 常驻，Whisper、Qwen3-TTS、Reranker 和 MFLUX 按请求加载。
- `18080`：既有 Qwen3.6 35B 候选，不由本目录接管。

常用命令：

```bash
npm run local-ai:status
npm run local-ai:smoke
npm run smoke:desktop-simulated --workspace=@agent-army/local-ai
ops/local-ai/install-launch-agents.sh
ops/local-ai/desktop/build-bundle.sh
```

统一调用入口是 `POST http://127.0.0.1:18082/v1/invoke`。请求包含 `capability`、`input` 和可选 `options`；当前本地正式能力为 `text.generate`、`vision.analyze`、`video.analyze`、`audio.transcribe`、`audio.synthesize`、`image.generate`、`image.edit`、`embedding.create`、`rerank.score`、`knowledge.index`、`knowledge.search`。

`video.generate` 仍是网络和显式授权能力；`audio.clone_authorized` 在专用声音克隆模型未安装前失败关闭。台式机增强节点通过私网 `LOCAL_AI_DESKTOP_BASE_URL` 和 `LOCAL_AI_DESKTOP_TOKEN` 配置；LAN 节点还必须把来源限制为 Mac 单地址。只有请求带 `approved=true` 才会跨设备发送输入，附件与产物都进行大小和 SHA-256 校验。未配置或断线时默认继续走 Mac；显式指定离线桌面节点则保留真实失败。

另一台电脑的运行包和说明位于 [`desktop/`](./desktop/)。当前 bundle 为 `work/local-ai/desktop-node-bundles/agent-army-4070-node-20260804.zip`；它包含 Windows/Linux 安装入口和 ComfyUI 适配器，但真实 GPU E2E 仍必须在目标 4070 电脑上执行。
