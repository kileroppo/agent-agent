# M4 岗位自主执行与能力深化验收

> 历史证据说明：本页记录的是当时 `step-router-v1` 和 A君本地自主计划控制面的真实调用结果。M5 已将 11 个正式岗位主模型改为 `stepfun/step-3.5-flash-2603`，并把本地 DAG、预算、checkpoint 和 CapabilityGrant Store 移出生产；开放任务继续通过无状态映射复用岗位能力。本页证据不代表当前生产仍生成这些历史产物，也不代表新主模型已完成真实调用验证。

| 层级 | 当前结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 契约与代码 | PASS | 11 个自主岗位 Manifest/Profile；GoalSpec、WorkPlan、CapabilityGrant；开放任务主链；显式依赖调度；另有 1 个不开放模型处理的私密只读岗位 | 无 |
| 自动化 | PASS | Manifest 13/13；A君运行时 549/549；M4 跨岗位语义门禁自检 6/6；Hermes 集成补丁 8/8 | 无 |
| 本地运行时 | PASS | A君 `127.0.0.1:4321` 已加载 11 个开放任务；任务 `44e0f347-cf22-43a8-88c3-3ef64d4fcb99` 完成计划/授权/执行/验证；任务 `c9c8df1f-1edc-47c3-bd4a-5a5607891dc6` 如实闭锁未知登录能力；任务 `ccdcf166-a140-4d51-af33-ed64cc391f9c` 证明任务预算可收紧到 15 分钟/6 调用/2 并发/1 层/1.5 美元；4 个活动 Gateway 已在模型切换后重启，其余 Profile 保持按需启动 | 无 |
| 外部模型 | ACCEPTED FOR AUTHORIZED SCOPE | 11/11 Profile 的无副作用主传输探针均由 `stepfun / step-router-v1` 返回固定结果；技术专家在 StepFun 被临时指向本机不可达端口时自动由 `deepseek / deepseek-v4-flash` 返回固定结果，随后已恢复 StepFun 正式地址；回退链在 11/11 Profile 均被 Hermes 识别 | 其余 10 个 Profile 的 DeepSeek 凭据未逐个产生付费调用，因此保留为“已配置、未单独探测” |
| 飞书/Paperclip | NOT CHECKED | 本次未发送测试消息、未创建外部任务 | 真实 heartbeat、原会话交付 |
| 岗位质量 | PASS | 11/11 自主岗位各完成 1 条 StepFun 复杂任务并通过岗位内容门禁；修复后 A君完成 1 次 StepFun 跨岗位回归，接受 11/11 产物并通过全部结构与事实一致性门禁 | 飞书/Paperclip 外部交付属于独立验收层，本轮未执行 |

## 已实现门禁

- 未登记能力不自动安装；
- 凭据、外部写入、付费和扩权保持审批；
- 计划无环、并发不超过 4、重规划最多 3 次；
- 没有已验证产物不能把开放任务标成完整成功；
- 模型策略不能被任务级能力请求修改。

## 2026-07-30 微信聊天取件员按需上岗

- 定位：该岗位是第 12 个活动岗位，但不属于 11 个开放自主任务 Profile；私密聊天禁止模型处理和动态扩权。
- 默认：只需给联系人或群名；时间为本地今天零点至当前、最多 200 条、先增量刷新，同名会话自动选择最近活跃且唯一的一条。未来结束时间会收敛到当前，不伪装成持续监控。
- 门禁：每个真实任务自动生成且只生成一条 `wechat-private-chat-read` 本机确认；范围绑定当前 Agent、任务、单一会话、起止时间和条数，一次批准只能消费一次。
- 脱敏：聊天原文与发送者只在当前执行内存中使用；私有报告权限 `0600`，只含消息数、时间边界、类型统计和范围证明，不进入 StepFun、DeepSeek、Paperclip、飞书或仓库。
- 验证：A君运行时 `549/549`、微信适配器与 Manifest 定向检查 `16/16` 通过；真实 A君进程已重启并显示 `status=active`、`independentRuntime=on_demand`。Proposal `430380ef-932d-4eea-98c3-27e905668771` 已从 `testing` 激活，Paperclip roster 同步成功。
- 证据边界：此前负责人批准的指定群真实只读冒烟返回 6 条消息，证明本机 Vault 可读；本轮没有再次读取真实聊天，也没有发送飞书消息。

## 2026-07-30 模型传输账本

- StepFun：11/11 无副作用探针通过，usage 均记录 `provider=stepfun`、`model=step-router-v1`、`error=null`。
- DeepSeek：1/1 受控回退探针通过，usage 记录 `provider=deepseek`、`model=deepseek-v4-flash`、`api_calls=1`、`error=null`，估算费用 `0.00273854 USD`。
- 排障偏差：小R和小办首次因 StepFun 国内 Key 仍指向国际默认端点而返回 HTTP 404，改为 Step Plan 国内正式端点后通过；一次回退预检因 Profile 环境优先级实际仍走 StepFun，usage 估算费用为 `0`，不计入 11/11 与 1/1 验收数。
- 恢复：技术专家的 `STEPFUN_BASE_URL` 已恢复为正式 Step Plan 地址；4 个常驻 Gateway 已取得新 PID。
- 限定：usage 的估算费用不是供应商账单；本轮没有执行飞书或 Paperclip 外部交付。

## 2026-07-30 岗位复杂任务账本

- 独立岗位：A君、小D、小R、小办、运维官、创建官、审核官、架构师、技术专家、小拆、小创各完成 1 条带完整本地材料的复杂任务；11/11 均由各自隔离 Profile 的 `stepfun / step-router-v1` 返回，并通过岗位专有内容门禁。
- 跨岗位：首次汇总的 usage 与结构门禁通过，但出现两项事实一致性错误；原始失败结果保存在 `cross-role-acceptance.initial.json`。同步 A君事实收敛 Prompt 后，唯一回归调用接受 11/11 岗位产物、未把已完成任务重标为未完成，并明确说明 `541/541` 自动化测试数与 `4 ready + 6 on_demand` 岗位状态数属于不同维度、不构成矛盾。
- 调用与费用：当前有效验收集包含 11 条岗位任务和 1 条修复后跨岗位回归，共 12 次 StepFun 调用；连同被保留的首次失败汇总，本阶段累计 13 次。usage 错误为 0，估算费用合计为 `0 USD`，外部副作用为 0；估算费用不是供应商账单。
- 实时接线：执行前发现 10/11 个自主 Profile 的 `SOUL.md` 仍是旧版；已备份并同步仓库最新 Prompt，A君新增跨岗位事实收敛规则，4 个常驻 Gateway 已重启。回归前仓库 Prompt 与实时 A君 `SOUL.md` 哈希一致。
- 门禁复核：本次回归输出已经明确“维度不同、不能直接比较、不视为矛盾”，旧判定器仍因同一项出现两组数字而误报。判定器已收窄为仅拦截真正混淆维度的输出，语义自检 6/6；随后复用同一份回归结果通过，没有产生额外模型调用。
- 已知质量风险：运维官内容通过，但模型输出的内部 `agentId` 写成“A君”；验收以实际 `operator` Profile 调用账本为身份真相，同时保留 `identityDrift` 记录。
- 证据：[岗位质量汇总](./artifacts/2026-07-30-role-quality/summary.json)、[修复后跨岗位验收](./artifacts/2026-07-30-role-quality/cross-role-acceptance.json)、[首次失败验收](./artifacts/2026-07-30-role-quality/cross-role-acceptance.initial.json)。
