# Agent军团仓库产品地图

本页回答三个问题：哪个目录是正式产品、哪个只在需要时运行、哪个仅为迁移或回滚保留。
机器可读真相是根目录的 [`repository-catalog.json`](../../repository-catalog.json)，架构检查会验证
Workspace、应用目录、入口文件和生命周期分类没有漂移。

## 正式运行产品

| 路径 | 角色 | 正式入口 |
| --- | --- | --- |
| `apps/ajun-runtime` | A君本机能力网关与执行适配 | `src/server.ts` |
| `apps/xiaod-media-transcriber` | 小D音视频转录整理 Agent | `src/server.ts` |
| `apps/mac-worker` | 私人云到 Mac 的出站工作桥 | `src/worker.js` |
| `integrations/local-ai` | 本机与 4070 的本地 AI 能力 Adapter | `local_ai_gateway.py` |
| `integrations/paperclip/plugins/content-autonomy` | Paperclip 内容自治插件 | `src/worker.js` |
| `integrations/publishing/m5-publisher-gateway` | 确定性外写 Gateway | `src/index.js`；默认关闭 |

Paperclip 和 Hermes 是外部平台，不在本仓库重新实现。飞书是日常交互入口；A君网页只提供授权、
健康、恢复和脱敏诊断。

## 按需工具

| 路径 | 用途 | 是否常驻 |
| --- | --- | --- |
| `apps/project-progress-board` | 本机多项目进度看板 | 否 |
| `apps/animated-chart` | M5 受控 Remotion 渲染工具 | 否 |

按需工具不是军团控制面，不能保存另一套组织、审批、预算或任务真相。

## 共享 Module 与平台 Adapter

- `packages/`：跨两个以上真实消费者共享的稳定契约或 Client；
- `integrations/access`：账号连接和内容获取 Adapter；
- `integrations/m5-kernel`：M5 Campaign/Case 领域内核；
- `integrations/paperclip/m5-content-pipeline`：Paperclip Pipeline/Case 工作流 Adapter；
- `integrations/boom-monitor`：旧 Boom Monitor 到 A君的兼容 intake，不是独立产品。

## 历史与回滚资产

`apps/boom-monitor` 是已退役 Python/Docker 实现，只用于数据迁移和受控回滚。正式实现位于
`apps/ajun-runtime/src/boom-monitor`，唯一回滚入口是 `ops/boom-monitor/docker-lifecycle.sh`。

旧目录仍包含本机 SQLite/日志等非 Git 数据，因此当前不做破坏性搬迁。它不在 npm Workspace 中，
目录清单也禁止把它重新标记为活动产品。完成数据保留期和恢复演练后，才能另行迁移到仓库外归档。

## 目录判断规则

1. 可独立运行、部署和验收的产品或业务 Agent 才进入 `apps/`；历史例外必须在目录清单中标记
   `legacy-rollback`，且不得进入 Workspace。
2. 平台接入进入 `integrations/`；领域行为不能直接依赖平台 SDK，应通过 Adapter Seam。
3. 只有两个以上真实消费者才进入 `packages/`。
4. 部署、监控、恢复和回滚协议进入 `ops/`，不得混入业务任务真相。
5. `work/` 只保存本机生成物、候选包和隔离工作区，不是源码入口，也不能被运行文档当作当前 live 证明。
