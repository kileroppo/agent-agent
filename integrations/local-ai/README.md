# Local AI Capability Adapter

本机 Mac 与授权 4070 节点的统一 AI 能力 Adapter。轻量 Gateway 负责固定能力路由、资源互斥、
按需启动和失败回 Mac；它不创建任务、审批、预算或审计真相。

生产入口是 `local_ai_gateway.py`，部署、状态和恢复命令统一由 [`ops/local-ai`](../../ops/local-ai/README.md)
管理。跨设备发送输入必须携带明确批准，配对 Token 不得打印或写入仓库。

```bash
cd integrations/local-ai
npm test
npm run check
```
