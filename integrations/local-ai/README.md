# Local AI Capability Adapter

本机 Mac 与授权 4070 节点的统一 AI 能力 Adapter。轻量 Gateway 负责固定能力路由、资源互斥、
按需启动和失败回 Mac；它不创建任务、审批、预算或审计真相。

生产入口源码是 `local_ai_gateway.py`，但正式服务不会直接运行 checkout 文件。安装器会把 Gateway、索引与检索 Adapter 冻结为内容哈希插件版本，并把依赖、日志、索引和产物放到项目目录外。部署、迁移、状态和恢复统一由 [`ops/local-ai`](../../ops/local-ai/README.md) 管理。跨设备发送输入必须携带明确批准，配对 Token 不得打印或写入仓库。

```bash
cd integrations/local-ai
npm test
npm run check
```
