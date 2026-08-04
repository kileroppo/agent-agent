# 本地 AI 能力系统验收

| 字段 | 内容 |
| --- | --- |
| 日期 | 2026-08-04 |
| 主节点 | M1 Max 64GB |
| 外部副作用 | 0 |
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
| 取消 | 正在运行的 FLUX 进程被终止，HTTP 409 + `request_cancelled` | 18082 `e2e-cancel-fixed` |

## 自动化与架构

- `npm test --workspace=@agent-army/local-ai`：8/8；
- `npm run check --workspace=@agent-army/local-ai`：Python 编译通过；
- A君定向测试：129/129；
- `npm run check:architecture`：通过；
- 根级 `npm test`：全部 workspace 与脚本测试通过，0 失败；
- 根级 `npm run check`：全部声明的架构与语法检查通过；
- 私聊分析器拒绝非回环地址，同时兼容旧 Ollama 测试并默认切到 Qwen3.5 OpenAI-compatible 服务；未读取真实微信聊天。
- 台式机转发只允许私网地址，拒绝 URL 内嵌凭据，并要求每个跨设备请求显式 `approved=true`；未配置节点的真实请求返回稳定失败，不伪装回退成功。
- 本地 AI 与 4070 节点契约专项 25/25：LAN 监听要求长 token 与来源 allowlist；adapter 配置、固定模型清单、单 GPU 资源门、附件字段/大小/SHA-256、产物目录/大小/SHA-256、无关 secret 不传给子进程均覆盖；
- 双 HTTP 进程模拟验收：无 token 的 `/health` 返回 401；Mac 文本转发到 `simulated-4070`；图片字节跨节点物化；模拟节点生成产物被校验并重新保存为 Mac 本地路径；远程长请求可取消并以 `request_cancelled` 收尾；停止节点后健康变为 unavailable，正式 18082 的默认请求继续由 Mac `local-qwen3-embedding` 返回 1024 维结果。另有专项测试证明桌面已配置但离线时 `auto` 文本路由不探测桌面节点、直接使用 Mac。该证据验证跨机契约，不等于真实 CUDA 性能或 FLUX 质量；
- A君本机能力客户端专项 3/3；真实回读 18082 得到 11 项 E2E 能力；合成两条微信消息经 18081 得到结构化摘要，`containsRawChat=false`、`containsSenderIdentifiers=false`。

## 运行切换与剩余边界

- 18081/18082 已分别由 `com.agent-army.local-ai.qwen35` 和 `com.agent-army.local-ai.gateway` 守护；实际工作目录、端口、健康已回读；跨机协议加载后 18082 PID 从 88060 更新为 26582，随后文本与 Embedding smoke 再次通过；既有 18080 仍返回 `status=ok`；
- A君已从干净 source commit `087fd39bb5eae6628c579a43f704c469c1dfe1d0` 冻结并切到 release `6a41ec6ad78ff1361ae950be2fe49ca52f530fd8b59ae9e919741be5219bfa12`；1107/1107 A君测试、main/recovery smoke 和静态闭包校验均通过；4321 强制重启后 PID `22344` 的命令、cwd 仍指向该 release，live 概览回读 `local-ai=ready`（11 项 E2E）和 `wechat-private-read=ready`，随后 `npm run local-ai:smoke` 再次通过；
- 4070 Ti Super 位于另一台电脑，但尚未提供其系统、内网地址或可用登录入口；局域网 mDNS 和邻居只读发现未找到可确认节点。Windows/Linux 节点代码、ComfyUI 适配器、安装脚本和 bundle 已生成，但没有向未知设备安装，也没有真实 CUDA/显存/图片质量证据；
- 视频生成和授权声音克隆按方案保持失败关闭，本轮没有外部 Provider 调用或额外模型下载。
