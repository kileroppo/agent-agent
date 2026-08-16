# 本地 AI 能力系统验收

## 2026-08-16 项目外插件迁移

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 插件版本 | PASS | `npm run local-ai:plugin:status` 返回活动内容哈希 `7516c36b26e156390d370649255d42ef9a05052444b8a5699ba54f6c3e807c5d` |
| 项目解耦 | PASS | live LaunchAgent 的 program、arguments、cwd、stdout/stderr 全部位于 `$HOME/Library/Application Support/AgentArmy/`，不含项目 checkout；`work/local-ai` 已不存在 |
| 可移植安装 | PASS | 安装器支持新 Apple Silicon Mac 的 `--bootstrap --download-models`，动态生成本机 LaunchAgent；模型和 Python 依赖均有固定版本清单 |
| 热切换与回滚 | PASS | 插件 release 按内容哈希保存，`current` 原子选中活动版本；迁移测试覆盖空目录合并、配对文件保留和运行根回滚 |
| 自动化 | PASS | `npm run check && npm test` 全部通过；插件管理专项 3/3，本地 AI Adapter 专项 28/28 |
| 真实运行 | PASS | 最终 release 重装后 `18082` 可达，11 项 Mac 能力仍 configured；文本与 Embedding 真实 smoke 输出 `local AI smoke: ok`；A君 `/api/local-ai/control` 返回 `ready`。网关总状态仅因 4070 离线显示 `degraded` |
| A君与 Paperclip | PASS | `runtime:fingerprint` 显示 A君仍运行原不可变 release、HTTP 200、`local-ai=ready`；Paperclip HTTP 200，本轮未切换二者发布包 |
| 空间 | PASS | 项目目录 `473488 KiB`（约 462 MiB）；外置本地 AI 运行根 `1675844 KiB`（约 1.60 GiB）；保留的插件代码 releases 合计约 `396 KiB` |

迁移前验收表中的 `work/local-ai/...` 是历史证据位置；同类日志、索引与产物现位于 `$HOME/Library/Application Support/AgentArmy/local-ai/` 的对应子目录。此次迁移没有调用云端模型、付费 Provider、飞书或发布接口，也没有读取或展示 4070 配对 token。4070 节点在最终回读时为离线，Mac 本地能力和回退路径保持健康；该离线状态不冒充跨机复验通过。

| 字段 | 内容 |
| --- | --- |
| 日期 | 2026-08-04 |
| 主节点 | M1 Max 64GB |
| 外部副作用 | 无云端调用、发布或付费动作；仅配置用户授权的 Windows 增强节点 |
| 付费调用 | 0 |
| 真实私人数据 | 未读取 |

## 能力证据

| 能力 | 真实样本结论 | 证据 |
| --- | --- | --- |
| 文本 | `LOCAL_AI_OK` 精确返回 | 18082 `e2e-text` |
| 单图/OCR | 正确识别“正在转录音视频” | 18082 `e2e-vision` |
| 视频理解 | 4 秒红转绿测试视频逐时间点识别正确 | `work/local-ai/artifacts/video/e2e-video-precise/` |
| TTS | Vivian 生成 4.4 秒中文 WAV | `work/local-ai/artifacts/tts/e2e-tts/` |
| ASR | 回转识别“你好，这是统一本地人工智能网关的语音验收测试” | `work/local-ai/artifacts/asr/e2e-asr/` |
| Embedding | 3×1024；同义句相似度 0.8426，高于无关句 0.3972 | 18082 `e2e-embedding-2` |
| Rerank | 北京文档 1.0，上海 0.1738，香蕉约 0.000028 | 18082 `e2e-rerank` |
| 本地知识索引 | 4 条文档建成 1024 维版本化索引；查询“中国的首都”将北京置顶，且过滤 `restricted` 文档 | `e2e-knowledge-index`、`e2e-knowledge-search`、`work/local-ai/indexes/local-ai-acceptance.sqlite3` |
| 文生图 | 红色方块、紫色球体均按提示生成 | `work/local-ai/artifacts/images/` |
| 单图编辑 | 红方块改绿、紫球改黄且构图保持 | `work/local-ai/artifacts/images/` |
| 多参考图 | 红、绿两参考方块合成到同一画面 | `work/local-ai/artifacts/images/flux2_multi_reference.png` |
| 4070 文生图 | Windows ComfyUI/FLUX.2 Klein FP8 在 RTX 4070 Ti Super 生成 512×512 红色方块，4 步、31.786 秒 | `work/local-ai/artifacts/desktop/e2e-4070-generate/comfyui-c61d5e08-f0ad-45.png`；SHA-256 `83e9c72c…321f` |
| 4070 图片编辑 | 同一远端工作流将红方块改为深蓝并保持构图、光照和白色背景，5.227 秒 | `work/local-ai/artifacts/desktop/e2e-4070-edit/comfyui-2128e696-5bec-47.png`；SHA-256 `9d4e032e…6d3e` |
| 4070 断线回退 | 临时把增强节点切到不可达端口，`auto` 请求真实回到 Mac MFLUX 并生成 256×256 图片；恢复配对后增强节点重新健康 | `work/local-ai/artifacts/images/e2e-4070-disconnect-mac-fallback/generated.png`；SHA-256 `7490bb62…f36` |
| 新版 4070 跨机生成/编辑 | Mac 18082 经批准路由到 Windows 新节点；绿色 A 圆形生成后正确编辑为橙色 B 圆形，两份产物均回传 Mac 并目视确认 | `work/local-ai/artifacts/desktop/mac-windows-final-generate/comfyui-02931b5e-3c16-42.png` SHA-256 `cf3012d0…cc063`；`work/local-ai/artifacts/desktop/mac-windows-final-edit/comfyui-69636782-3421-43.png` SHA-256 `83e5d35f…afa4` |
| 4070 按需冷启动 | ComfyUI 处于 `stopped` 时直接从 Mac 发起图片任务，Windows 节点自动冷启动 ComfyUI 并在 62.434 秒后回传正确的黄色五角星；验收后 A君停止 ComfyUI，18083 仍显示 `running` | `work/local-ai/artifacts/desktop/mac-final-cold-on-demand-4070/comfyui-52171921-f42b-46.png`；SHA-256 `45157bff…f38c2` |
| 新版断线回退与恢复 | A君断线时显示 4070 `offline`，同一 `auto` 请求真实使用 Mac MFLUX；恢复配对并重连后，4070 再次生成成功，6.642 秒 | `work/local-ai/artifacts/images/mac-final-disconnect-fallback-2/generated.png` SHA-256 `29488ea8…9fae2`；`work/local-ai/artifacts/desktop/mac-final-reconnected-4070/comfyui-b1ec965c-1b20-40.png` SHA-256 `02f7ef1a…b4b9` |
| 取消 | 正在运行的 FLUX 进程被终止，HTTP 409 + `request_cancelled` | 18082 `e2e-cancel-fixed` |

## 自动化与架构

- `npm test --workspace=@agent-army/local-ai`：28/28；
- `npm run check --workspace=@agent-army/local-ai`：Python 编译通过；
- A君 workspace 全量测试：1114/1114；
- `npm run check:architecture`：通过；
- 根级 `npm test`：全部 workspace 与脚本测试通过，0 失败；
- 根级 `npm run check`：全部声明的架构与语法检查通过；
- 私聊分析器拒绝非回环地址，同时兼容旧 Ollama 测试并默认切到 Qwen3.5 OpenAI-compatible 服务；未读取真实微信聊天。
- 台式机转发只允许私网地址，拒绝 URL 内嵌凭据，并要求每个跨设备请求显式 `approved=true`；未配置节点的真实请求返回稳定失败，不伪装回退成功。
- 本地 AI 与 4070 节点契约专项 28/28：LAN 监听要求长 token 与来源 allowlist；adapter 配置、固定模型清单、单 GPU 资源门、附件字段/大小/SHA-256、产物目录/大小/SHA-256、无关 secret 不传给子进程、受管 ComfyUI 所有权与空闲释放、停止 ComfyUI 不误报轻量控制节点离线、禁用的 35B 候选不可启动均覆盖；
- 双 HTTP 进程模拟验收继续覆盖鉴权、附件、产物、取消和离线默认路由；其后又在真实 RTX 4070 Ti Super 上完成 CUDA/FLUX 生成、编辑和断线回退，因此跨机契约与真实设备路径均已有独立证据；
- A君本机能力客户端专项 6/6；A君与网关控制 API 覆盖离线恢复、固定动作、策略净化及 409 错误保真；六个岗位的 `local_ai_invoke` 由 Manifest 能力白名单控制，跨设备审批不能由 Agent 自行开启。真实回读 18082 得到 11 项 E2E 能力；合成两条微信消息经 18081 得到结构化摘要，`containsRawChat=false`、`containsSenderIdentifiers=false`。

## 运行切换与剩余边界

- 18082 `com.agent-army.local-ai.gateway` 是轻量常驻控制面；18081 `com.agent-army.local-ai.qwen35` 的 plist 已确认 `RunAtLoad=false`、`KeepAlive=false`。从停止状态发起真实文本调用返回 `ON_DEMAND_OK` 并启动 Qwen；随后从 A君停止，等待健康端口退出后保持停止，普通控制状态查询没有把它重新唤醒。Embedding 与 Reranker 同样只在请求时装载并支持空闲释放；
- A君 4321 仍从不可变 release `0a49f0dc2dae3bc385363464a723d4e879617a03f2ef1c601f7881ea1ceac816`（payload `9fa4e105c11bf8f31ee5eacc86320062a1fd51d6a5e79076b6e8ce615182d52c`，PID `6388`）运行，冻结包 main/recovery smoke 与静态闭包通过。live 返回九个能力服务：18082 和 18083 轻量控制节点均为 `running`，ComfyUI 验收后为 `stopped/on_demand`，Embedding 与 Reranker 为 `stopped/on_demand`。另一个正在运行的媒体知识流水线于本轮验收期间独立启动了 `qwen-knowledge` 与 `qwen35-knowledge` screen，因此 18080/18081 当前有外部任务占用，对应 A君 LaunchAgent 仍为 `not running`；本轮不停止该用户流水线。A君自身的 18080 策略仍为 `disabled`且不进入 Agent 路由，尝试由 A君启动仍准确返回 HTTP 409；
- Windows 增强节点位于 `192.168.10.110:18083`，ComfyUI `0.30.1`、Python `3.13.12`、PyTorch `2.10.0+cu130` 已识别 RTX 4070 Ti Super 16GB；三份固定权重大小与 SHA-256 均匹配，真实工作流峰值约 14,333 MiB。节点防火墙只允许 Mac `192.168.10.111`，无 token `/health` 返回 401，配对文件在 Mac 上为 0600 且 token 未进入聊天或文档；计划任务 `\\AgentArmy\\RTX4070EnhancementNode` 只运行轻量 18083 节点。新版 bundle（SHA-256 `6d46de13940fa044800d5b42311964c3c4dd7e0a3d4a8770a726f6f7b1f16b3e`）已部署到目标机；Windows Codex 回报其本机验收文件为 `C:\\AgentArmy4070\\windows-acceptance.json`，本轮未复制或读取其中凭据。Mac 端又独立实测了 A君启动/停止/重启/重连、生成/编辑、断线回 Mac 与恢复后 4070 再次生成；验收结束后 ComfyUI 已主动停止，18083 轻量节点继续正确显示 `running`；
- 视频生成和授权声音克隆按方案保持失败关闭，本轮没有外部 Provider 调用。4070 初始图片增强模型合计 12,451,820,124 字节，下载完成后已清空该三仓库的 `.incomplete` 临时分片。
