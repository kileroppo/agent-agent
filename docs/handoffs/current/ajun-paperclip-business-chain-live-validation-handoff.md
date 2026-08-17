# A君 / Paperclip 三岗位真实业务链复验交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 进行中 / 待运行配置与重启授权 |
| 创建时间 | 2026-08-17（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | Codex / 负责人 |
| 关联任务 | A君任务 `14e0720c-d912-441a-94b9-ea40387d7f57`；Paperclip `AGE-1585` |
| 截止条件 | 新任务真实完成小D取证、小拆正式拆解、小办本地汇报，且父子任务、Paperclip Issue、运行记录和本地产物一致收口 |

## 1. 接手目标

- 目标：跑通“小D取证 → 小拆正式内容拆解 → 小办老板汇报”的真实业务链，并验证 Paperclip 与 A君控制台能区分进程退出和业务闭环。
- 用户约束与不可做事项：可以充分使用 AI 额度；本轮只做本地交付，不发送飞书消息、不公开发布、不读取或回显凭据；保留现有脏工作区和 Paperclip 中文化改动。
- 做完的定义：父任务和三个子任务按依赖顺序进入真实终态；每个成功岗位有通过任务门禁的可读产物；Paperclip 父子 Issue 与 A君状态一致；控制台能显示关联 Paperclip run 且不把 process `succeeded` 冒充业务成功。
- 唯一下一步：负责人明确授权后，只同步小D、小拆、小办 Profile 的 `tools.tool_search.enabled=off`，从任务相关干净提交冻结并切换 A君不可变 release，然后新建一条本地交付复验任务。
- 允许继续的前提：负责人明确允许修改上述三个 Hermes Profile、创建任务相关提交/不可变 release，并重启 A君 4321。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码 | 父任务改为 A君本机确定性规划；Paperclip 父 Issue 不再唤醒 A君模型；业务分工的公开 URL 和依赖以安全白名单投影 | `task-execution-coordinator.ts`、`paperclip-task-projector.ts` | 已验证，未部署 |
| Hermes | 无人值守 Paperclip adapter 不再开放 `clarify`；受管 Profile 策略把小工具集的 Tool Search 设为 `off` | `governance-hermes-runtime.ts`、Profile 配置器 | 已验证，未应用 |
| 运行记录 | Reconciler 读取最新 Paperclip run；进程成功但无岗位回写时记录 `paperclip_process_exited_without_completion`；本机任务详情投影脱敏 run 状态 | `paperclip-hermes-task-reconciler.ts`、`task-record-service.ts`、控制台任务记录 | 已验证，未部署 |
| 失败复现 | `AGE-1585` 连续三个 Hermes run 均显示 process `succeeded`，但没有计划、子任务或产物；前两次错误声称缺少 URL，最终 Issue `blocked`、A君任务 `failed` | Paperclip Issue、run log、A君任务详情 | 已验证 |
| 当前 live | A君仍运行旧不可变 release；上述修复尚未进入 4321 | `npm run runtime:fingerprint` 与 release manifest | 未部署 |

## 3. 变更与决策

- 已完成：复现假成功；修正父任务执行边界；补齐安全业务上下文投影；关闭无人值守交互追问；增加 process/business 双层收口；控制台展示脱敏 Paperclip run；补充回归。
- 关键文件：`apps/ajun-runtime/src/task-execution-coordinator.ts`、`paperclip-task-projector.ts`、`governance-hermes-runtime.ts`、`paperclip-hermes-task-reconciler.ts`、`task-record-service.ts`、`frontend/src/task-record-workbench.ts`、`apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs`、`integrations/hermes/scripts/set-feishu-toolsets.py`。
- 已确定边界：A君本机只负责确定性生成总任务依赖计划；Paperclip 负责父子 Issue、岗位唤醒和审计；小D、小拆、小办仍由各自 Hermes Profile 执行业务。
- 不要重复创建：不要重试 `AGE-1585`，它保留为故障证据；授权后应使用新幂等键创建新任务。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | 相关链路 172/172；根目录 `npm test` 退出 0；前端重新构建后任务记录测试 9/9 | 无 |
| Profile dry-run | PASS / NOT APPLIED | `configure-governance-hermes-runtime.mjs --dry-run --only ajun,xiaod,video-content-analyst,office-assistant`；MCP、SOUL、任务范围无漂移，三业务岗位仅需 Tool Search `auto → off` | 尚未应用 live Profile |
| 运行时 | FAIL / OLD RELEASE | 旧 live 复现 `AGE-1585` 假成功并最终失败 | 新 release 尚未切换，未做 PID/cwd/listener/readback |
| 外部平台 | FAIL / PAPERCLIP NOT CLOSED | Paperclip 三个 process run `succeeded`，Issue `blocked`，无业务产物 | 修复后新父子 Issue 未创建 |
| 人工验收 | NOT CHECKED | 无 | 小D确认稿、小拆报告、小办汇报的内容质量 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：应用 Profile 配置、创建干净不可变 release、重启 4321 均需要负责人明确授权；当前脏工作区还包含负责人已有的 Paperclip 中文化文件，提交和 release 必须只纳入本任务路径。
- 不得复制或展示的信息：Hermes/Paperclip Provider 凭据、飞书凭据、Cookie、Profile 原始配置内容、私有路径日志。
- 需要谁确认：负责人明确回复允许上述三个 Profile 修改、任务相关提交/冻结和 A君重启。
- 关闭条件：新任务父子状态和 Paperclip Issue 一致；小D、小拆、小办各自具有真实可读且通过门禁的产物；A君控制台显示正确 run 状态；运行时指纹证明新不可变 release 已生效；负责人完成内容质量抽查。
- 关闭证据链接：完成后补入本交接和对应验收记录。
