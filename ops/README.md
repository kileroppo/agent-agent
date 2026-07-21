# Ops

这里存放军团的本地运行、部署、健康检查、监控、备份和故障恢复工具。

业务逻辑不放在这里；运维脚本不得回显 secret、token、Cookie 或用户私密内容。

运行身份、外部验证和验收证据要求见 [测试与验收规范](../docs/standards/testing-and-acceptance.md)。

## A君常驻运行

`launchd/ai.agent-army.ajun-runtime.plist` 是 A君本机运行台的受控启动项：仅监听 `127.0.0.1:4321`，供同机 Hermes 调用，不向局域网开放。安装或更新后使用：

```sh
cp ops/launchd/ai.agent-army.ajun-runtime.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist
```

若该启动项已存在，先用 `launchctl bootout gui/$(id -u)/ai.agent-army.ajun-runtime`，再重新 `bootstrap`。日志写入应用 `data/`，不得提交或复制其中的私密任务内容。
