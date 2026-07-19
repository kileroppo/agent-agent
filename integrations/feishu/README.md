# 飞书集成

M1 使用传统飞书机器人能力与长连接事件，不暴露公网回调地址。

## 已完成的测试环境准备

- 已创建并发布一个仅供 M1 使用的传统飞书个人版机器人应用；
- 机器人能力已启用；
- 仅订阅 `im.message.receive_v1`；
- 使用长连接接收事件；
- 仅开通 `im:message` 与读取用户发给机器人的单聊消息所需权限；
- 外部群与外部用户单聊均关闭；
- 当前一键智能体应用保留但不作为 M1 入口：这是为了优先验证现成的传统机器人 Hermes 适配器；此前未收到入站消息的具体原因尚未证实，不能据此判断该应用不兼容；
- 隔离 Hermes Gateway 曾以前台模式建立长连接，当前已停止；尚未使用新传统机器人凭据发送或接收真实消息。

## 凭据配置边界

真实值只能由应用所有者手动写入隔离 Profile 的本地环境文件，例如：

```text
~/.hermes/profiles/xiaod/.env
```

变量名见 [`.env.example`](./.env.example)。不要将真实 App ID、App Secret、用户标识或 token 写入仓库、文档、测试输出或聊天记录。

`FEISHU_ALLOWED_USERS` 只能填写获授权人员的用户 `open_id`（常见前缀为 `ou_`），不能填写单聊会话 ID（前缀为 `oc_`）。白名单变化后必须重启隔离 Gateway 才会生效。

## 启动前门禁

1. 从新传统机器人应用的“凭证与基础信息”手动获取 App ID、App Secret，写入隔离 Profile，并保留允许用户白名单；
2. 设置小D专用模型配置，避免从终端或默认 Profile 继承密钥；
3. 使用隔离 Profile 启动 Gateway 并验证长连接成功；
4. 从飞书发送一条无敏感内容的测试消息，验证消息接收、身份准入和幂等创建；
5. 关闭 Gateway 或保留受控本机服务，再记录验收结果。

对应角色映射见 [小D Hermes Profile](../hermes/profiles/xiaod.profile.json)，M1 平台证据见 [验收记录](../../docs/reviews/m1-xiaod-feishu-closure/acceptance.md)。
