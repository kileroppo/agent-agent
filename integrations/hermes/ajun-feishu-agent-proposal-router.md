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

## 多员工飞书入口（准备完成，尚未逐个上线）

日常始终可以只找 A君。需要让某位已上岗员工在飞书中也有独立入口时，为该员工使用单独的飞书应用与 Hermes 运行配置，并设置：

```text
AJUN_FEISHU_COMMANDER_INGRESS_URL=http://127.0.0.1:4321/api/feishu/commander
AJUN_FEISHU_ENTRY_AGENT_ID=xiaod
```

第二项填写该员工的岗位编号，例如 `xiaod` 或 `public-reporter`。消息仍由 A君统一登记、审批、跟进和回到原聊天；不会为每个员工另造一套任务或审批系统。没有完成飞书应用配置、权限、事件订阅和真实私聊回归的岗位，必须保持“未上线”，不能出现在可直接联系的员工列表中。

当 A君 把公开素材任务交给小D后，会返回受限的本机任务跟进信息。Hermes 跟进 A君 中的完整任务链：第一次失败后若运维官安全重试，会继续等待；最终成功时交付已确认权限的文档，无法恢复时说明运维官和技术专家的接手情况。只在得到最终结论后向原飞书会话发送一次结果；跟进地址只接受本机回环地址，不能被消息内容改成外部地址。

当 A君 返回 `local` 一次性审批时，适配器会在同一会话发送“批准本次范围 / 拒绝并关闭”交互卡。按钮回调只调用本机 A君审批接口，带飞书会话与决定人引用；A君会二次校验审批状态、有效期、范围和原会话后才恢复任务。`paperclip` 审批不会被这张 local 卡放行，仍由 Paperclip 决定。

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
