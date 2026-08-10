# Business Workflow 与能力治理候选验收记录

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| TypeScript | PASS | `npm run check --workspace=ajun-runtime` | 无 |
| 架构门禁 | PASS | `npm run check:architecture`；Workflow 必须 TS，禁止直连平台、网络和进程 | 无 |
| 自动化 | PASS | 根目录 `npm test` 全量通过 | 不代表外部平台闭环 |
| 候选运行态 | PASS | `4322`、禁用后台服务；首页 200，overview 返回分层能力真相和 237 条历史验证欠账 | 使用兼容本地账本，不等于 4321 live |
| live 身份 | PARTIAL | `npm run runtime:fingerprint`：4321 可达但绑定 release `2f8309d7…` / Git `aebb7f0…`，与候选源码不同 | 未冻结、未切换新 release |
| 飞书外部验收 | NOT CHECKED | 未发送测试消息 | 新能力真相文案、真实业务 Workflow、人工评价闭环待新 release 后验证 |
| 外部写入 | NOT CHECKED / DISABLED | Publisher 4390 未运行 | Campaign、Cron、Provider 和平台写入均不在本轮范围 |

## 已验证行为

- 新任务获得稳定 workflow/step 身份，跨岗位子任务继承同一 workflowId；
- Policy 拒绝 Model 自批，区分自动允许、本机人工、Paperclip 人工和拒绝；
- 小拆普通故事板通过受控本机视觉 Adapter；网关/模型故障时自动恢复一次、重试一次，仍失败才给用户安全提示；
- ExecutionReceipt 不保存原始路径或输入，只保存 SHA-256 和执行身份；
- 小R多路发现或反证质量门失败时，任务即使写成 succeeded 也不能让 Workflow 冒充已验证；
- 小办在任何工具调用前核对“总页数包含封面”，提纲冲突直接 needs_input；
- 飞书结果评价复用为 Workflow 人工验收：有用=`accepted`，需改进=`revision_required`；
- MCP、飞书和控制台不再把岗位登记/进程在线格式化为“全部可用”。
