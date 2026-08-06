# Ops

这里存放军团的本地运行、部署、健康检查、监控、备份和故障恢复工具。

业务逻辑不放在这里；运维脚本不得回显 secret、token、Cookie 或用户私密内容。

运行身份、外部验证和验收证据要求见 [测试与验收规范](../docs/standards/testing-and-acceptance.md)。

## A君常驻运行

`launchd/ai.agent-army.ajun-runtime.plist` 是 A君本机运行台的受控启动项：仅监听 `127.0.0.1:4321`，供同机 Hermes 调用，不向局域网开放。默认 `AGENT_ARMY_EMPLOYEE_FEISHU_OWNER=local`，员工飞书长连接只由这台 Mac 接管；迁移云端时必须按混合在线部署包的唯一接管顺序切换。安装或更新后使用：

```sh
cp ops/launchd/ai.agent-army.ajun-runtime.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist
```

若该启动项已存在，先用 `launchctl bootout gui/$(id -u)/ai.agent-army.ajun-runtime`，再重新 `bootstrap`。日志写入应用 `data/`，不得提交或复制其中的私密任务内容。

个别本机环境会让 `bootstrap` 返回系统输入输出错误，但旧式加载仍可正常启动。只有确认服务未注册且 4321 没有监听时，才可使用下面的恢复命令，并立即检查 4321 是否恢复：

```sh
launchctl load -w ~/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist
```

## 小D常驻运行

`launchd/ai.agent-army.xiaod.plist` 是小D的本机受控启动项：仅监听 `127.0.0.1:4318`，供同机 A君调用。安装或更新后使用：

```sh
cp ops/launchd/ai.agent-army.xiaod.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.agent-army.xiaod.plist
```

若该启动项已存在，先用 `launchctl bootout gui/$(id -u)/ai.agent-army.xiaod`，再重新 `bootstrap`。日志写入小D应用 `data/`，不得提交或复制其中的私密任务内容。

## Paperclip 常驻运行

`launchd/ai.agent-army.paperclip.plist` 以已验证的本机 Paperclip CLI 启动组织级总控，保持 loopback-only 配置，并始终使用 `--no-repair`：启动不会初始化、迁移或自动修复既有组织数据。安装或更新后使用：

```sh
cp ops/launchd/ai.agent-army.paperclip.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.agent-army.paperclip.plist
```

如果启动项已存在，先 `launchctl bootout gui/$(id -u)/ai.agent-army.paperclip`，再重新 `bootstrap`。首次恢复后只允许执行健康、既有组织读取和低风险 heartbeat 验证；新 Agent、扩权、外发、付费和其他组织级动作仍必须等待 Paperclip 审批记录。该启动项引用本机已缓存的 `paperclipai` 版本；升级或清理 npm 缓存前，必须先更新并验证启动项，不得让运行时静默改用其他版本。
