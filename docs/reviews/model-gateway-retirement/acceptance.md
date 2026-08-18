# 模型网关退役验收

| 字段 | 内容 |
| --- | --- |
| 日期 | 2026-08-17 |
| 状态 | 配置与运行验收；真实模型传输待单独授权 |
| 范围 | LiteLLM + PostgreSQL Docker 栈退役；12 个 Hermes Profile 恢复 StepFun 官方直连 |
| 付费调用 | 0（本验收不发送模型提示词） |
| Secret | 迁移脚本仅从本机私密文件读入内存；未回显、未写入仓库 |

## 结论

本机文本模型不再依赖 LiteLLM、PostgreSQL 或 `127.0.0.1:4000`。`default`、`ajun`、
`architect`、`content-creator`、`creator`、`intel-researcher`、`office-assistant`、
`operator`、`reviewer`、`technical-expert`、`video-content-analyst` 与 `xiaod` 共 12 个
Hermes Profile 均恢复为 StepFun 官方入口。

这不是“模型已经可用”的证明：本次没有发送付费模型提示词，也没有检查套餐余额、实际
StepFun 响应或业务产物质量。

## 2026-08-17 现场证据

- `manage.mjs status` 回读 `gateway: down`，12/12 Profile 均为
  `shared_upstream + direct`；12/12 的 `model.max_tokens` 均回读为 `8192`。
- 5 个实际运行的 Gateway 已重启并加载新配置：default `94680`、小R `94694`、
  小办 `94731`、运维官 `94747`、小D `94752`；进程 argv/cwd 或 LaunchAgent 的
  `HERMES_HOME` 与各自 Profile 对应。
- `agent-army-model-gateway-gateway-1` 与 `agent-army-model-gateway-db-1` 已由
  `docker compose down` 移除，专用网络已移除，`127.0.0.1:4000` 无监听。
- `agent-army-litellm-postgres` 命名卷仍保留；本次全军回退备份目录为 `0700`，
  `direct-cutovers.json` 为 `0600`。未读取备份中的凭据内容。
- 迁移采用逐文件原子替换，并在整批失败时尝试从本次全军备份补偿恢复；它不是跨 12 个
  Profile 的数据库事务，也未声称能覆盖并发外部修改。

## 保留与取消

| 项目 | 退役后状态 |
| --- | --- |
| Hermes `max_tokens`、最大轮次、会话压缩 | 保留，由 Hermes Profile 执行 |
| Paperclip 组织级预算、审批、审计 | 保留，仍是唯一组织级真相 |
| 每岗位独立虚拟钥匙 | 取消 |
| 普通直聊的每日美元硬停 | 取消 |
| 4 万输入 Token 的统一预拒绝 | 取消 |
| LiteLLM 调用、Token、估算费用聚合报表 | 取消 |

图像、语音、ASR 与其他独立 Provider 不属于本次文本网关退役范围，其原有凭据、费用与业务
账本边界不变。

## 不付费验证账本

| 验收项 | 通过条件 | 可接受证据 | 不证明的内容 |
| --- | --- | --- | --- |
| 12 个 Profile 配置 | 每个 Profile 的 StepFun Base URL 为官方入口，且不再为本地 `4000` | 脱敏配置对账；不得回显 API Key | 真实认证、额度和模型响应 |
| Hermes 运行加载 | 受影响 Gateway 重启后，PID/argv/cwd 与配置回读一致 | 本机进程和配置只读检查 | 一次真实模型调用成功 |
| Docker 退出 | LiteLLM 与 Postgres 容器不再运行，`127.0.0.1:4000` 无监听 | `docker ps`、`lsof -nP -iTCP:4000 -sTCP:LISTEN` | 旧数据卷已经安全删除 |
| 数据与回滚保留 | 退役前的私密运行目录、切换备份和 Docker 卷在删除窗口外保留 | 仅记录路径/权限/存在性，不读取钥匙 | 可直接恢复的真实调用链 |
| 仓库边界 | 不再有正式运行/验收文档把 LiteLLM、Postgres 或 4000 写为必需链路 | 文档与架构检查 | 用户业务质量 |

## 停止与回滚边界

- 本次在 12 个 Profile 完成配置与运行回读后，已按用户授权停止并移除该 Compose 的两个
  容器与专用网络；未删除命名卷或私密备份。
- 如果任一 Profile 恢复直连后出现认证或传输故障，先恢复该 Profile 的退役前私密配置，再决定是否重启对应 Hermes Gateway；不得为了诊断主动发送付费探针。
- 命名卷和私密备份仍是可恢复资产；删除它们需要负责人再次明确授权。
- 真实 StepFun 传输、费用、工具调用与业务产物质量必须在独立的费用授权下验收，不能把本记录的 `PASS` 升级为外部能力通过。
