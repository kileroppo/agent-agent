# 模型统一入口

这个目录只保存可审计配置和运维脚本，不保存任何真实钥匙。

- LiteLLM 固定为 `v1.94.1`，只监听 `127.0.0.1:4000`。
- PostgreSQL 保存虚拟钥匙、调用、Token 和预算记录。
- 每个 Hermes Profile 使用独立虚拟钥匙；任一岗位失控时只停它自己。
- 网关不记录 Prompt/回复正文，只记录归因、Token、耗时、状态和估算成本。
- Step 3.7 暂无独立公开价，硬预算暂按 Step 3.5 Flash 公布价格折算；Provider 后台仍是最终账单。
- 图像、语音和 ASR 暂不经过聊天网关，它们继续使用独立凭据与原有业务账本。

私密运行数据位于 `~/.config/agent-army/model-gateway/`，权限为 `0700/0600`。

常用命令：

```bash
node ops/model-gateway/manage.mjs prepare
node ops/model-gateway/manage.mjs start
node ops/model-gateway/manage.mjs provision
node ops/model-gateway/manage.mjs cutover --profile content-creator
node ops/model-gateway/manage.mjs status
node ops/model-gateway/manage.mjs usage --date 2026-08-16
node ops/model-gateway/manage.mjs rollback --profile content-creator
```

`cutover` 和 `rollback` 会先为 `.env` 与 `config.yaml` 创建 `0600` 备份，并用原子替换写入。命令输出不会包含任何真实钥匙。
