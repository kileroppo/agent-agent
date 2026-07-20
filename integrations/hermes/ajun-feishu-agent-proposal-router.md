# 飞书创建 Agent 强制路由

飞书消息出现“创建/新建/招募 Agent、智能体或岗位”时，Hermes 不先让模型自由解释，而是将原消息 ID 与文本提交到 A君本机入口：

```sh
HERMES_HOME=/Users/pengaro/.hermes/profiles/xiaod \
AJUN_AGENT_PROPOSAL_INGRESS_URL=http://127.0.0.1:4321/api/feishu/agent-proposals \
/Users/pengaro/.local/bin/hermes gateway run
```

入口只创建幂等的 `AgentProposal` 并提交 Paperclip 审核；不会创建生产 Agent、外部连接或权限。Hermes 立即在原飞书会话回复草案已提交；后续审核、测试和上线状态以 A君/Paperclip 为真相。

当前 Hermes 版本需安装本仓库受控补丁：

```sh
node integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs \
  /Users/pengaro/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py
```

升级 Hermes 后必须重新执行补丁脚本和其测试；未设置环境变量时，Hermes 保持原有文本处理，不会截获普通消息。
