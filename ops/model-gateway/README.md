# 已退役的模型统一入口（仅供受控回滚）

StepFun 直连是日常依赖；本目录保留的 LiteLLM/PostgreSQL 配置只用于受控回滚，不得作为新的日常接入方式。

这个目录只保存可审计配置和运维脚本，不保存任何真实钥匙。退役前网关提供过以下能力：

- LiteLLM 固定为 `v1.94.1`，只监听 `127.0.0.1:4000`。
- PostgreSQL 保存虚拟钥匙、调用、Token 和预算记录。
- 每个 Hermes Profile 使用独立虚拟钥匙；任一岗位失控时只停它自己。
- 单次输入超过 4 万 Token 会在付费调用前拒绝，单次输出最多 8192 Token。
- 网关不记录 Prompt/回复正文，只记录归因、Token、耗时、状态和估算成本。
- Step 3.7 暂无独立公开价，硬预算暂按 Step 3.5 Flash 公布价格折算；Provider 后台仍是最终账单。
- 图像、语音和 ASR 暂不经过聊天网关，它们继续使用独立凭据与原有业务账本。

私密运行数据位于 `~/.config/agent-army/model-gateway/`，权限为 `0700/0600`。

常用命令：

```bash
node ops/model-gateway/manage.mjs prepare
node ops/model-gateway/manage.mjs start
node ops/model-gateway/manage.mjs provision
node ops/model-gateway/manage.mjs probe --profile content-creator
node ops/model-gateway/manage.mjs cutover --profile content-creator
node ops/model-gateway/manage.mjs status
node ops/model-gateway/manage.mjs usage --date 2026-08-16
node ops/model-gateway/manage.mjs rollback --profile content-creator
node ops/model-gateway/manage.mjs direct --all
node ops/model-gateway/manage.mjs restore-gateway
node ops/model-gateway/manage.mjs retire
```

`cutover` 和 `rollback` 会先为 `.env` 与 `config.yaml` 创建 `0600` 备份，并用原子替换写入。命令输出不会包含任何真实钥匙。

## 改回 StepFun 直连并退役 Docker

`direct --all` 是全军操作，必须显式写 `--all`。它只改策略中 12 个 Hermes Profile 的：

- `.env` 中的 `STEPFUN_API_KEY` 和 `STEPFUN_BASE_URL`：钥匙仅从私密 `gateway.env` 的上游字段读入内存，绝不打印；
- `config.yaml` 中 `sstefun` 的 Chat 地址为官方 `/step_plan/v1`，以及存在的 `stepfun` Anthropic 地址为官方 `/step_plan`；
- 顶层 `model.max_tokens` 精确设为 `8192`，不伪造输入 Token 硬拒绝。

写入前会把全部 12 份 `.env` 和 `config.yaml` 放进一个新的 `0700/0600` 私密备份；任一岗位写入或记录失败时，脚本会尝试恢复全部岗位。为避免重跑覆盖唯一网关回退备份，`direct --all` 只有在 12 个 Profile 全部确认仍是 `gateway` 路由时才允许开始。`restore-gateway` 只使用这次全军直连产生的备份恢复统一入口配置，读取前会校验 manifest schema、12 个 Profile 集合及每份 `.env`/`config.yaml` 的 SHA-256；它也会在半途失败时尝试恢复操作开始前的全部配置。两种切换都需要重启对应 Hermes 进程后才会生效。

先运行 `status`：每个 Profile 的 `route` 会明确显示 `direct`、`gateway` 或 `mixed`，不显示钥匙。`retire` 会再次硬性核对 12 个 Profile 都是 `direct`，否则拒绝执行。该命令只对本目录的 Compose 执行 `down`，**不带 `-v`**，因此会停掉 LiteLLM/PostgreSQL 容器但保留数据库卷，便于恢复；它不会停 Hermes，也不会删除任何其他 Docker 容器。
