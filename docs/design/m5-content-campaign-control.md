# M5 内容活动控制流程

## 主流程

1. 负责人创建活动草案，页面只显示主题、平台、时间、发布上限、预算和账号授权状态；
2. 系统先完成本地干跑并给出预算，再显示“批准活动”；
3. 批准后显示当前阶段、正在工作的岗位、下一步、今日/总发布数量和停止按钮；
4. 任一步失败时显示真实失败阶段、已保留产物和唯一恢复动作；
5. 发布后显示平台凭证、2h/24h/72h 指标和待审核改进建议。

## 状态

`draft → waiting_approval → active → paused → completed`

并列终态：`stopped`、`expired`、`failed`。

界面与状态来源：

- 活动总览：Paperclip Pipeline Case；
- 岗位工作与依赖：Paperclip Issue、blocker relation 与 run；
- 审核/批准：Paperclip execution policy；
- 7 天日程：Paperclip Routine；2h/24h/72h 指标唤醒：Paperclip Issue Monitor；
- 内容产物与发布凭证：内容自治插件的受控工作区与业务实体；
- 确定性写回：publisher 写 `PublishReceipt` Work Product，metrics 写
  `MetricSnapshot`，retrospective 写版本化复盘 Work Product；
- 学习门禁：少于 5 条同类型真实 72h 指标只显示“样本不足”；达到 5 条才显示
  待审核 `LearningProposal`，且界面不得暗示已自动修改模板、权限或发布频率；
- 本机 4321 页面只做中文聚合，不保存第二份状态。

## 关键文案

- 草案：`活动尚未获得账号写入授权，不会发布。`
- 执行：`正在完成本地内容步骤；只有通过审核且在活动范围内才会发布。`
- 暂停：`活动已暂停，已完成产物保留，不会继续发布。`
- 风控：`平台出现验证码、风控或未知页面，活动已自动暂停。`
- 完成：`活动已结束；这里分别列出本地产物、平台凭证和仍未证明的指标。`

## 当前界面基线

live 为 15 个 Routine、18 个 Pipeline 阶段和 daily、publisher、metrics、
retrospective 4 个无模型 HTTP 控制器；插件 `0.3.0` 已加载 13 个工具。本机页面
必须继续显示真实状态：1 个未批准草案、`0/14`、每日 Cron 关闭、Paperclip
Secrets 为 0、Screen Recording 为 `false`。不得把目标源码、本地测试、插件
`ready`、Fake PublishReceipt 或控制器接线展示为“已授权”“已学习”或“已发布”。
