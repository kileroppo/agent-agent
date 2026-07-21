# 飞书军团总管路由

当配置了军团总管入口时，Hermes 将飞书文本及稳定消息引用提交给 A君本机入口，并在**原会话**回显结果：

- “整理视频/音频 + 公开链接” → 小D；缺少公开链接只要求补充，不启动处理；
- “检查系统状态” → 运维官本机健康检查；
- “创建/新建/招募 Agent、智能体或岗位” → 创建官草案与 Paperclip 组织级审核；
- 其余文本 → 任务协调官给出安全的补充信息或下一步建议。

```sh
HERMES_HOME=/Users/pengaro/.hermes/profiles/xiaod \
AJUN_FEISHU_COMMANDER_INGRESS_URL=http://127.0.0.1:4321/api/feishu/commander \
/Users/pengaro/.local/bin/hermes gateway run
```

每条任务用 `feishu:<message-id>` 幂等；普通小D和本机健康检查不投影 Paperclip。创建 Agent 只创建幂等的 `AgentProposal` 并提交 Paperclip 审核；不会创建生产 Agent、外部连接或权限。

未配置军团总管入口时，可保留旧的“只拦截创建 Agent”兼容入口：

```sh
HERMES_HOME=/Users/pengaro/.hermes/profiles/xiaod \
AJUN_AGENT_PROPOSAL_INGRESS_URL=http://127.0.0.1:4321/api/feishu/agent-proposals \
/Users/pengaro/.local/bin/hermes gateway run
```

当前 Hermes 版本需安装本仓库受控补丁：

```sh
node integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs \
  /Users/pengaro/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py
```

升级 Hermes 后必须重新执行补丁脚本和其测试。未设置任一入口环境变量时，Hermes 保持原有文本处理，不会截获普通消息；不要把环境变量值、飞书用户标识或会话内容写进仓库。
