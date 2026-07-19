# Hermes 集成

本目录保存仓库中的 Hermes 映射基线，不保存 Hermes 真实 Profile、会话、密钥或个人配置。

`profiles/*.profile.json` 是 AgentManifest 到 Hermes 的平台无关映射契约，目前不是可以直接导入 Hermes CLI 的原生配置文件。真实字段必须经过当前 Hermes 版本的隔离验证后，由适配器生成或校验。

M1 约束：

- 每个 Agent 使用独立 Profile；
- 飞书用户准入默认白名单；
- Kanban 保存执行任务和运行历史；
- 业务 checkpoint 与产物仍由业务应用存储；
- 不读取或复用个人默认 Profile；
- REST/插件接口不暴露公网。

## Profile 作用域注意事项

本机验证发现，单独设置 `HERMES_PROFILE=xiaod` 不足以让所有 Hermes CLI 命令切换到隔离 Profile；通用状态命令仍可能读取默认环境。小D的启动与验收必须显式使用其独立 Profile 目录作为 Hermes Home，不能把通用 `hermes status` 的输出当作小D Profile 的凭据或模型证明。
