# 本地 AI 运行服务

本目录只托管本机模型适配与资源互斥，不创建业务任务、审批、预算或审计真相；这些仍由 A君与 Paperclip 负责。

- `18081`：Qwen3.5-9B MLX-VLM，默认不常驻；真实文本、视觉或视频请求到来时由 18082 启动，空闲后释放。
- `18082`：轻量统一能力控制面，由 LaunchAgent 常驻；Embedding、Reranker、Whisper、Qwen3-TTS 和 MFLUX 均按需加载或按请求运行。
- `18080`：Qwen3.6 35B 旧文本候选，已纳入 A君但默认禁用，不进入任何 Agent 默认路由；需要时先在 A君改为按需，再手动启动。

A君 `账号与接入 → AI 能力中心` 是唯一日常管理入口：显示 Mac 与 4070 的能力、负载模式、启动/停止/重启、备用路由以及节点检测/重连。状态探测不会唤醒重模型。A君本身可以在 18082 停止时直接恢复这个轻量控制面；所有动作都映射到固定服务 ID 和固定操作，不接受任意命令。

常用命令：

```bash
npm run local-ai:status
npm run local-ai:smoke
npm run smoke:desktop-simulated --workspace=@agent-army/local-ai
ops/local-ai/install-launch-agents.sh
ops/local-ai/desktop/build-bundle.sh
```

统一调用入口是 `POST http://127.0.0.1:18082/v1/invoke`。控制入口是 `GET /v1/control`、`POST /v1/control/services/{serviceId}/{action}` 和 `PUT /v1/control/services/{serviceId}/policy`。请求包含 `capability`、`input` 和可选 `options`；当前本地正式能力为 `text.generate`、`vision.analyze`、`video.analyze`、`audio.transcribe`、`audio.synthesize`、`image.generate`、`image.edit`、`embedding.create`、`rerank.score`、`knowledge.index`、`knowledge.search`。

`video.generate` 仍是网络和显式授权能力；`audio.clone_authorized` 在专用声音克隆模型未安装前失败关闭。台式机增强节点通过私网 `LOCAL_AI_DESKTOP_BASE_URL` 和 `LOCAL_AI_DESKTOP_TOKEN` 配置；正式启动脚本会优先从 `$HOME/Library/Application Support/AgentArmy/local-ai/mac-pairing.json` 安全加载 0600 配对文件，不打印 token。LAN 节点还必须把来源限制为 Mac 单地址。只有请求带 `approved=true` 才会跨设备发送输入，附件与产物都进行大小和 SHA-256 校验。未配置或断线时默认继续走 Mac；显式指定离线桌面节点则保留真实失败。

另一台电脑的运行包和说明位于 [`desktop/`](./desktop/)。当前 bundle 为 `work/local-ai/desktop-node-bundles/agent-army-4070-node-20260804.zip`，SHA-256 为 `6d46de13940fa044800d5b42311964c3c4dd7e0a3d4a8770a726f6f7b1f16b3e`。Windows `192.168.10.110:18083` 已完成真实 RTX 4070 Ti Super GPU E2E：FLUX.2 Klein 4B FP8 生成、编辑、产物回传及断线回 Mac 均通过。当前在线节点还是旧版：A君已能检测和重连 18083，也能检测 ComfyUI，但需部署新版 bundle 后才能从 A君按需启停 ComfyUI；这项边界不会显示成已完成。
