# Agent军团领域语言

本文件固定核心编排使用的业务词义，避免任务、通知和内容活动在不同运行时中被重复解释。

## Language

**任务受理（Task Intake）**：
一个尚未执行、但已完成输入规范化、幂等识别、岗位路由、能力与风险门禁的任务信封。
_Avoid_: 任务创建 helper、请求预处理

**任务通知（Task Notification）**：
从任务链、恢复链和已验证产物派生的单条用户可见进度或交付说明。
_Avoid_: 聊天状态、完成文案

**岗位执行（Role Execution）**：
已核验的 Paperclip 指派被绑定到岗位、Case、可信工具范围和唯一任务信封后，由对应岗位执行器产生并回读已验证 Work Product 的过程。
_Avoid_: 员工 handler、岗位分支集合

**活动生命周期（Campaign Lifecycle）**：
CampaignGrant 从草案、批准、运行、暂停/恢复到停止，并与每日 Case、Cron 和 readiness 保持一致的状态序列。
_Avoid_: Campaign helper、状态更新器

**活动阶段执行（Campaign Stage Execution）**：
活动 Case 按固定 Route 进入 Hermes 或确定性工具，并在执行前规划输入、在重放时核验同一 Case 与 Work Product 证据的过程。
_Avoid_: 阶段 method、工具参数 helper

**活动交付证据（Campaign Delivery Evidence）**：
把脚本、配音、渲染、静态卡、机器审核、PublishReceipt 与 Provider 回执绑定为同一来源链的一组可重放不变量。
_Avoid_: 输出 JSON、校验 helper

**发布尝试（Publish Execution）**：
在重新核验 CampaignGrant、连接器批准、预算和不可变媒体租约后，以唯一幂等键完成一次平台写入并保存 PublishReceipt 的安全协议。
_Avoid_: 发布请求、connector 调用

**指标采集（Metric Collection）**：
PublishReceipt 到期后，以固定 2h/24h/72h collectionKey 领取短租约、调用只读指标连接器并以 CAS 写回快照的安全协议。
_Avoid_: 指标查询、采集 helper

## Relationships

- 一次 **任务受理** 产生一个可执行或等待输入/审批的任务信封。
- **岗位执行** 只能消费已核验的 Paperclip 指派，并将结果写回原任务信封与原 Case。
- 一个任务信封在任意时刻最多派生一条当前 **任务通知**。
- **活动生命周期** 使用 Paperclip Case 和 CampaignGrant 作为唯一活动真相，不创建第二套任务状态。
- **活动阶段执行** 只能推进活动生命周期允许的 Case；它产生的 **活动交付证据** 必须能从同一 Case、Project、Provider 回执和工作区文件重放。
- **发布尝试** 只能消费已完成重放校验的 **活动交付证据**；成功后产生的 PublishReceipt 是后续 **指标采集** 的唯一输入。

## Example dialogue

> **开发者：** “收到内容发布请求后，是否直接进入活动生命周期？”
> **领域负责人：** “不。先完成任务受理；只有 CampaignGrant 经负责人批准后，活动生命周期才能启用每日 Case 和 Cron。任务通知只解释当前真相，不能推进状态。”

## Flagged ambiguities

- “状态”曾同时指任务真相和聊天展示；已明确：任务/Paperclip 保存真相，**任务通知**只是派生说明。
