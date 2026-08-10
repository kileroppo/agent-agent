# Business Workflow 与能力治理验收记录

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| TypeScript | PASS | `npm run check --workspace=ajun-runtime` | 无 |
| 架构门禁 | PASS | `npm run check:architecture`；Workflow 必须 TS，禁止直连平台、网络和进程 | 无 |
| 自动化 | PASS | 根目录 `npm test` 全量通过 | 不代表外部平台闭环 |
| 不可变发布 | PASS | 当前 live 来自最终主线的 clean immutable release；发布前全量测试、启动烟测和恢复烟测通过，精确 release / payload / Git 身份以 manifest 与只读指纹为准 | 文档不硬编码会被自身提交改变的当前身份 |
| live 身份 | PASS | `runtime:fingerprint` 必须显示源码与 live 为 `same_git_head`、release worktree clean、HTTP 200；精确 PID 与 release 哈希不在会改变自身 Git 身份的文档中硬编码 | Publisher 关闭使整体指纹保持 degraded，这是安全边界 |
| Paperclip / Hermes 岗位同步 | PASS | Paperclip roster 已同步 12 个岗位；小拆与 A君 Hermes Profile 二次 dry-run 均为 `changed=false` | 不代表外部发布或人工内容采用 |
| 飞书状态验收 | PASS | A君回复按“已登记/在线/已验证/人工验收”分层；处理图标出现，回复后刷新无残留，未创建任务 | 无 |
| Workflow 状态一致性（live） | PASS | `#716FA2E8` 为 `waiting_validation` 且 `ownerAction=null`；`#B5403CD9` 为 `waiting_acceptance`；live `ownerActionable=1` 且只指向后者 | 历史任务终态保持只读，不被展示层改写 |
| 能力证据一致性（live） | PASS | 所有 `truth.verified=true` 项均有有效 `verifiedAt` 与 `evidenceRef`；公开资料、飞书和演示文稿能力同时返回最近失败及 `freshness=later_than_latest_failure` | 能力证据不等于人工采用具体业务产物 |
| Hermes 用量归因（live） | PASS | 真实 802 条任务和 7 天 169 条 Hermes 账本：5 条绑定 task，164 条分类为 `agent_session`，`system=0`、真正 `unattributed=0`；新 Hermes oneshot 任务保留原生 `session_id` | 历史任务没有 sessionId，不倒推伪造精确关联 |
| 真实 Workflow | PASS | 任务 `#167203DF`，Workflow `workflow:a5517f230c8b1f465471dcef`，Step `step:health-observation:cb458f79e30b9338`；A君、小D、Paperclip 均 healthy | 健康验收不等于所有业务能力已验证 |
| 人工评价闭环 | PASS | 原飞书会话调用 `task_feedback`，账本写入 `feedback.sentiment=useful` 和 `humanAcceptance.status=accepted` | 无 |
| 历史欠账治理（live） | PASS | 802 条任务；`ownerActionable=1` 且只指向 `#B5403CD9` 的可选内容验收，`historicalArchived=184`、`validatedByLaterEvidence=92`、`reviewBacklog=0`、`verificationBacklog=0`、`unresolvedFailures=0`；其中 `expected_boundary_rejection=5` | 历史失败仍保留，不因分类变化改写终态 |
| 严格后续证据 | PASS | mission 仅在已验证子产物被后续正式交付消费且计划项完整时消债；研究委托要求委托类型和同一来源/主题；恢复链要求同源业务成功晚于原失败及恢复任务创建时间 | 不把无关主题、早于恢复链的成功或部分交付当作后续成功证据 |
| 验证批次（live） | PASS / CLOSED | `agent.army/validation-campaign/v1` 为 `taskCount=0`、`groupCount=0` | 自动化历史复验已无剩余任务 |
| 恢复与修复代码层 | PASS | 53 个恢复/修复专项测试通过；A君与小D固定回环健康探针均 HTTP 200 且契约通过 | 代码和当前健康不替代历史业务任务重新成功 |
| 真实账本无 Provider 回放 | PASS | 只读任务 `#10E4F814` 的实际确认稿、10 帧、1 故事板生成 13 模块 `deterministic_fallback` 报告；`completeness=partial`、`visualCoverage=unavailable`；临时目录已清理 | 不证明视觉 Provider 可用，也不证明人工内容质量 |
| M3 本机纵向验收 | PASS / NO PROVIDER | 分析 13 模块、两平台待审草稿和受控知识归档链通过；未启用 Hermes Advisor 或 Provider | 不证明真实视频听审、Paperclip heartbeat、飞书交付或人工内容质量 |
| 首次真实小拆 | EXPECTED WAITING TEST | `#716FA2E8` 的任务终态为 `waiting_test`，Workflow 显示为 `waiting_validation` 且不要求负责人处理；DeepSeek 1 次，5218 input / 13466 output tokens，估算 0.004501 USD；模式结构未通过；视觉 Provider 未调用 | 未形成可自动接受终态 |
| 修复后真实小拆 | PASS | `#B5403CD9` 为 `succeeded` / `paperclip_hermes_completed`；模式结构 `false → 单次 deterministic repair → true`；报告 7077 bytes、摘要 194 字；DeepSeek 1 次，3043 input / 8809 output tokens，估算 0.0028986328 USD；视觉 Provider 未调用 | 自动结构通过不等于人工采用内容 |
| 外部写入 | NOT REPORTED | 两条任务均无独立外写回执；Paperclip 本机 completion sync 只证明本机任务完成同步 | 账本未报告外部写入，不能断言为零；不等于外部发布 |
| 只读回放副作用 | PASS / ZERO | `#10E4F814` 回放 `databaseWrites=0`、`liveTaskStoreWrites=0`、`providerCalls=0`、`paidCalls=0`、`externalSideEffects=0` | 只适用于该次本机只读回放，不外推到真实 DeepSeek 任务 |

## 已验证行为

- 新任务获得稳定 workflow/step 身份，跨岗位子任务继承同一 workflowId；
- Policy 拒绝 Model 自批，区分自动允许、本机人工、Paperclip 人工和拒绝；
- 小拆普通故事板通过受控本机视觉 Adapter；网关/模型故障时自动恢复一次、重试一次，仍失败才给用户安全提示；
- 模型型验证先进入预算 Policy：岗位能力已登记、费用已知且预算内可自动执行；超预算、费用未知、敏感数据或扩权才进入人工闸门；
- ExecutionReceipt 不保存原始路径或输入，只保存 SHA-256 和执行身份；
- 小R多路发现或反证质量门失败时，任务即使写成 succeeded 也不能让 Workflow 冒充已验证；
- 小办在任何工具调用前核对“总页数包含封面”，提纲冲突直接 needs_input；
- 飞书结果评价复用为 Workflow 人工验收：有用=`accepted`，需改进=`revision_required`；
- MCP、飞书和控制台不再把岗位登记/进程在线格式化为“全部可用”。
- `不外发或发布` 会整体按并列否定处理，不再把后半句误判为高风险；原误判任务 `#4C4C2921` 已拒绝关闭，未执行。
- 5 条带可验证拒绝产物、不可重试并符合安全边界的旧失败按 `expected_boundary_rejection` 归档；执行器崩溃、部分 mission 交付或有正式来源的真实失败不会误入该类。
- 小拆精华模式在模型输出结构不合格时先停在 `waiting_test`；修复后只允许一次确定性结构修复，修复通过才进入成功终态，不额外调用模型。
- A君 Hermes Profile 已受控新增 `task_feedback`；跨飞书会话写回会被拒绝，聊天中的“存档”不再代替任务账本事实。
- 人工评价回复后，飞书服务端对该用户消息查询到的 Reaction 数量为 `0`；Chrome 页面刷新后曾短暂统计到 1 个图标节点，但不是服务端仍存在的 `Typing` Reaction，不据此改写任务或处理状态。

## 最终边界

- 自动化历史复验已在 live 收敛为 `validationCampaign=0/0`；`#B5403CD9` 证明真实 DeepSeek 小拆可以经过一次确定性结构修复进入成功终态，Paperclip 本机 completion sync 已完成。
- `#10E4F814` 真实账本回放继续证明无 Provider 时的本地确定性纯文本降级路径；它与真实 DeepSeek 任务是两层不同证据，不互相冒充。
- Publisher、Campaign、Cron 仍按配置保持关闭；两条真实任务的账本未报告外部写入且无独立回执，因此不能据此断言外部写入为零，也不将 Paperclip 本机 completion sync 当作外部发布。
- 本历史能力验证批次的自动化闭环已完成；该批次唯一保留边界是人工内容质量未验收。结构门禁通过不等于负责人已采用内容；如需形成最终采用结论，负责人可抽查 `#B5403CD9` 并登记 `accepted` 或 `revision_required`。项目其他验收以当前交接索引为准。
