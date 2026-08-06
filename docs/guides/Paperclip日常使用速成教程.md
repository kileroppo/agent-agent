# Paperclip 日常使用速成教程

> 适用于本仓库的“Agent军团”。目标不是学完 Paperclip，而是能独立完成：派任务、看进度、验产物、处理审批、控制预算、创建受控 Agent 和恢复失败。

## 1. 先记住这一句话

**飞书找 A君办事，Paperclip 管公司。**

| 系统 | 你用它做什么 |
| --- | --- |
| 飞书 / A君 | 日常提需求、补材料、收结果、处理普通一次性确认 |
| Paperclip | 组织、正式任务、员工、heartbeat、预算、组织级审批、暂停/恢复、审计 |
| Hermes / Codex / Claude | 真正运行模型和工具 |
| 小D、小R、小办、小拆、小创等 | 产出各自领域的业务结果 |

Paperclip 不是聊天机器人，也不负责判断业务产物一定合格。它是控制面：让任务有负责人、有预算、有运行记录、有审批、有结果引用。

## 2. 打开正确的公司

1. 在运行 Paperclip 的 Mac 上打开 [http://127.0.0.1:3100](http://127.0.0.1:3100)。
2. 左上角公司选择器选 **Agent军团**。
3. `killer` 是练习组织；其中的 `Chief of staff` 不是正式 A君。

当前实例是本机可信模式，无登录页，只允许本机访问。不要把 `3100` 端口直接暴露到局域网或公网。

## 3. 系统界面快速导览

### 3.1 整体布局

```text
┌────────────左侧导航────────────┬────────────主工作区────────────┐
│ 公司切换、搜索、新建任务       │ 当前页面标题和主要操作         │
│ Dashboard / Inbox             │ 列表、看板、图表、任务或员工详情 │
│ Work                          │                                │
│ Agents                        │                    右侧属性面板 │
│ Company                       │                    状态和关系   │
└───────────────────────────────┴────────────────────────────────┘
```

- **左上公司名**：切换“Agent军团”和练习组织 `killer`。操作前先看这里。
- **搜索图标**：按 `AGE-607`、任务标题或员工名快速定位，不要在几百条历史任务中一直滚动。
- **Collapse sidebar**：收起左侧栏，内容较宽时使用。
- **右上 Board**：当前操作者账号，不是某个 Agent。
- **右侧 Properties**：任务状态、负责人、项目、依赖、审核人等；看不到时点任务顶部的 **Show properties**。

### 3.2 左侧导航分区

| 分区 | 页面 | 主要用途 |
| --- | --- | --- |
| 快捷入口 | New Task | 从任何页面新建任务 |
| 快捷入口 | Dashboard | 看员工、任务、费用、审批和近期活动总览 |
| 快捷入口 | Inbox | 只看需要人处理的事项；优先处理 Blocked 和审批 |
| Work | Tasks | 任务列表和看板，是日常主要工作区 |
| Work | Routines | 定时创建具体任务 |
| Work | Goals | 公司、团队、员工或任务目标 |
| Work | Artifacts | 跨任务查找报告、文件和文档产物 |
| Work | Skills | 公司技能库；把复用流程分配给员工 |
| Work | Projects | 管理长期范围、任务板、工作区和项目预算 |
| Agents | 员工快捷项 | 打开常用员工详情 |
| Agents | See all agents | 查看全部员工和状态 |
| Company | Org | 组织图和汇报关系 |
| Company | Timeline | 按时间查看工作和运行变化 |
| Company | Costs | 用量、费用和预算策略 |
| Company | Activity | 结构化审计：谁改了任务、员工、预算或审批 |
| Company | Settings | 公司设置、招聘策略、适配器等低频配置 |

Approvals 没有固定显示在当前左侧导航时，可从 **Dashboard 的 Pending Approvals 卡片**或 Inbox 进入。

### 3.3 Dashboard 怎么看

顶部四张卡是第一眼信息：

- **Agents Enabled**：员工总数，以及 running、paused、error 数；
- **Tasks In Progress**：正在执行、开放和阻塞任务数；
- **Month Spend**：本月已记录费用和预算状态；
- **Pending Approvals**：等待你决定的审批。

下面的 Run Activity、Tasks by Priority、Tasks by Status 和 Success Rate 用来看趋势。它们不是业务验收结论：历史任务、自动巡检和旧失败都会影响图表。

Recent Activity 显示最近的结构变更；Recent Tasks 用来快速回到近期任务。

### 3.4 Tasks 页面怎么用

任务页顶部从左到右：

- **New Task**：新建任务；
- **Search tasks**：按标题或短任务号搜索；
- **List view / Board view**：列表适合筛选，看板适合按状态推进；
- **Parent-child nesting**：是否把父子任务折叠在一起；
- **Columns**：选择显示字段；
- **Filter**：按状态、员工、项目、优先级等过滤；
- **Sort**：调整排序；
- **Group**：按状态、员工等分组。

Agent军团已有大量历史和自动巡检任务。日常不要从头滚动，先过滤：

```text
状态：todo / in_progress / in_review / blocked
时间：最近
员工：当前负责人
项目：当前工作
```

看到大量历史 `blocked` 不等于系统当前全部故障。优先看 Inbox → Blocked 中真正需要处理的项目，以及最近仍有活动的业务任务。

### 3.5 New Task 弹窗怎么填

实际弹窗从上到下是：

| 控件 | 作用 |
| --- | --- |
| Task title | 写目标结果 |
| For | 负责人；从员工页点 Assign Task 时会自动选中 |
| Project | 所属长期项目，可不选 |
| Add reviewer or approver | 需要复核或批准时添加 |
| Add description | 写输入、交付物、限制和完成标准 |
| Todo | 初始状态；准备执行通常用 Todo |
| Priority | 真实影响处理顺序时才设置 |
| Upload | 附加任务所需文件 |
| Agent / Plan / Ask mode | 选择执行、方案或问答模式 |
| Create Task | 标题和必要字段完成后才能提交 |

**For 是“谁负责”，Mode 是“最终留下什么”**，两者不要混淆。

### 3.6 任务详情页怎么读

任务顶部显示状态、短任务号、项目、参与人和标题。中间区域依次是：

1. **Description**：任务契约；
2. **Sub-tasks**：父子任务和完成情况；
3. **Upload attachment / New document**：补充材料或创建任务文档；
4. **Chat**：员工的工作更新、问题和你的纠偏；
5. **Activity**：状态、负责人等结构变化；
6. **Related work**：相关任务、运行和工作区；
7. **回复框**：继续补材料或给反馈。

右侧 Properties 重点字段：

- **Status / Priority / Labels**：当前处理状态；
- **Assignee / Project**：负责人和所属项目；
- **Parent / Blocked by / Blocking / Sub-tasks**：任务依赖；
- **Reviewers / Approvers**：谁复核、谁批准；
- **Monitor**：需要自动监控外部等待时使用；
- **About**：来源、创建、完成和更新时间。

任务顶部的 **Copy task as markdown** 适合把脱敏任务摘要交给其他工具。复制前仍要检查是否包含私人数据或敏感参数。

### 3.7 员工详情页怎么读

员工页顶部按钮：

| 按钮 | 什么时候用 |
| --- | --- |
| Star | 把常用员工固定到左侧 |
| Assign Task | 创建一张明确任务并自动选中该员工 |
| Run Heartbeat | 首次验收或修改配置后单次测试；日常派活不用再点 |
| Pause / Resume | 临时停止或恢复员工 |
| More actions | 复制 ID、重置会话、终止等低频操作 |

状态徽标显示 `idle`、`running`、`paused` 或 `error`。不要只看颜色，要读状态文字和 Latest Run。

员工页六个 Tab：

- **Dashboard**：最近运行、任务趋势、近期任务和费用；
- **Instructions**：岗位职责和禁止事项；
- **Skills**：该员工实际分配的公司技能；
- **Configuration**：Adapter、模型、工作目录、环境和唤醒策略；
- **Runs**：每次 heartbeat 的 transcript、事件、日志、费用和工作区；
- **Budget**：该员工的预算策略。

### 3.8 想做什么就点哪里

| 你的目的 | 最短路径 |
| --- | --- |
| 找任务 | 搜索图标 → 输入 `AGE-xxx` |
| 新建任务 | 左侧 New Task，或员工页 Assign Task |
| 看员工为什么没动 | Agent → Runs → 最新运行 |
| 给任务补材料 | Task → Chat → Reply |
| 看实际产物 | Task → Output / Artifacts / 附件 |
| 解决卡住 | Inbox → Blocked → 读原因 → 补材料、决定或重新指派 |
| 处理招聘/预算审批 | Dashboard → Pending Approvals |
| 控制费用 | Costs，或 Agent / Project → Budget |
| 查谁改了状态 | Task → Activity，或 Company → Activity |
| 暂停员工 | Agent → Pause |
| 查看组织关系 | Org |

## 4. 日常任务怎么形成闭环

### 4.1 默认从飞书开始

对 A君说清五件事：

```text
目标：
输入材料：
交付物：
限制：
什么算完成：
```

示例：

```text
目标：分析这 3 个竞品视频的内容打法。
输入材料：3 个公开链接。
交付物：共同点、差异、可复用结构、5 个选题建议。
限制：只读公开内容，不登录、不发布。
完成标准：每条判断能对应到来源，最终给我一份可读报告。
```

低风险、单员工、能立即完成的工作可以直接由 A君路由，不必为了留痕强行创建 Paperclip 任务。跨员工协作、长任务、预算、扩权、账号连接、公开发布、暂停/终止和组织级审计才进入 Paperclip。

### 4.2 需要时直接创建任务

点击左侧 **New Task**，或进入 **Tasks → New Task**：

| 字段 | 写法 |
| --- | --- |
| Title | 写结果，不写动作，例如“完成 3 个竞品视频分析” |
| Description | 目标、输入、交付物、限制、验收标准 |
| Assignee | 选真正具备能力的员工 |
| Project | 长任务放进对应项目；临时问答可以不选 |
| Priority | 只在确实影响顺序时提高 |
| Dependencies | 下游必须等待上游产物时再设置 |

工作模式只看“最后要留下什么”：

- **Ask**：只要一个答案，例如“这个失败是什么原因？”
- **Plan**：只要方案，批准前不实施。
- **Agent**：当前界面名称；对应官方文档的 Standard 模式，要文件、代码、报告、配置或其他可验收产物。

任务分配给员工后通常会自动唤醒员工，不需要再点 `Run Heartbeat`。

### 4.3 看进度不要只看状态

任务状态通常是：

```text
backlog → todo → in_progress → in_review → done
                         ↘ blocked
```

- `todo`：已准备好，等待员工领取。
- `in_progress`：员工正在处理。
- `in_review`：产物已交，等待检查。
- `blocked`：必须读评论，解决缺材料、决定、权限或依赖。
- `done`：任务记录已完成，但仍要检查真实产物和外部交付。

打开任务后重点看：

1. **Chat / Comments**：员工做了什么、卡在哪里、下一步是什么；
2. **Output / Work products**：实际文件、报告或结果；
3. **Runs**：这次由谁、用什么适配器、何时运行、是否报错；
4. **Activity**：状态和负责人究竟是谁改的。

需要纠偏时直接在任务评论里写具体要求。不要只写“重做”，要指出哪一部分不合格、正确标准和是否继续使用原材料。

### 4.4 什么才算完成

至少同时满足：

- 任务负责人和范围正确；
- 运行没有停在错误或待审批；
- 真实产物存在、可读、内容符合验收标准；
- 涉及飞书、发布或外部平台时，外部交付确实发生；
- 费用、权限和审批没有越界。

`done`、一次绿色 heartbeat 或一段模型回复，都不能单独证明业务闭环完成。

## 5. Heartbeat 和 Routine 怎么用

Heartbeat 是员工的一次工作脉冲：被唤醒、读取任务、执行、回报、退出。员工不是一直运行。

推荐默认值：

- **定时 heartbeat：关闭**；
- **按任务/评论唤醒：开启**；
- **Run Heartbeat：只用于首次验收、修改说明/技能/配置后的单次测试**。

不要给每个员工设置“每 5 分钟醒一次”。没有任务也会产生运行、噪音和费用。

Routine 用于“到了时间就必须创建一张具体任务”的工作，例如每天 09:00 生成日报、每半小时做一次健康巡检。它不是让员工无目的醒来查看有没有事。

每个 Routine 至少写清：

- 触发时间；
- 创建什么任务；
- 指派给谁；
- 输入变量；
- 重复运行策略；
- 失败后由谁处理。

## 6. 员工页面怎么读

进入 **Agents → 某员工**：

| 区域 | 作用 |
| --- | --- |
| Dashboard | 当前状态、任务和最近运行 |
| Instructions | 岗位职责、工作规则、禁止事项、交付标准 |
| Skills | 可复用流程和工具说明 |
| Configuration | 运行时、模型、工作目录、环境和唤醒策略 |
| Runs | 每次 heartbeat 的记录、transcript、日志和费用 |
| Budget | 该员工的成本上限 |

常见状态：

- `idle`：配置正常，正在休息；
- `running`：当前有 heartbeat；
- `paused`：人为、预算或系统暂停；
- `error`：最近一次 heartbeat 失败；
- `pending_approval`：招聘尚未批准。

`paused` 不等于故障。Agent军团中部分 HTTP 适配员工由 A君按业务路径唤醒，不能因为看到暂停就批量恢复。

## 7. 创建 Agent：先练习，再走正式流程

### 7.1 安全练习：在 `killer` 创建低权限员工

不要直接在“Agent军团”里练手。切换到 `killer`：

1. 进入 **Agents → New Agent**；
2. Name：`Paperclip练习员`；
3. Title：`入门演练`；
4. Role：普通员工，不设为 CEO 或管理者；
5. Reports to：选择 `Chief of staff`；
6. Adapter：选已通过环境测试的 `codex_local`；
7. Working directory：使用独立练习目录，不要指向包含私人数据的目录；
8. 点击 **Test environment**，必须看到命令、工作目录和认证可用；
9. 定时 heartbeat 关闭，按需唤醒开启；
10. 创建后进入 Budget 设置一个很小的演练上限；
11. 完成练习后使用 **Pause**，不要用不可逆的 Terminate。

练习 Instructions 可以直接使用：

```text
你是 Paperclip 入门演练员工。
只处理明确指派给你的任务。
只能回答或生成当前任务要求的练习产物。
不得创建员工、分派任务、联网、外发、发布、读取私人数据或修改生产配置。
缺少输入时说明缺什么并停止。
完成时给出结果、验证依据和唯一下一步。
```

权限全部保持最小：

- Create agents：关闭；
- Assign tasks：关闭；
- 修改公司技能：关闭或不授予；
- 外部账号、秘密、发布、付费能力：不配置；
- 只保留 Paperclip 运行所需的必需技能。

创建后给它一个 **Ask** 任务：

```text
标题：用三句话解释 Paperclip
要求：分别说明它是什么、不是什么、我什么时候需要打开它。
```

完整练习闭环：

```text
创建员工
→ Test environment
→ 设置最小权限和预算
→ Assign Task
→ 自动 heartbeat
→ 查看 Runs 和任务评论
→ 检查答案/产物
→ 查看 Activity 和 Costs
→ Pause 练习员工
```

### 7.2 正式创建：Agent军团不能直接手工上岗

正式新员工必须走：

```text
飞书向 A君描述岗位需求
→ 创建官生成 AgentProposal 草案
→ 架构师检查现有能力和边界
→ 审核官检查权限、预算和外部动作
→ Paperclip 批准 / 拒绝 / 要求修改
→ A君创建隔离测试实例
→ 执行一条白名单真实任务
→ 检查真实产物和权限
→ 通过后才 active 上岗
```

给 A君的岗位需求模板：

```text
创建一个【岗位名称】。
它负责：
输入：
交付物：
允许读取的数据：
允许使用的工具：
明确禁止：
单任务预算和重试上限：
哪些动作必须再次审批：
一条最小验收任务：
```

批准草案不等于正式上岗。只有适配器可用、权限可阻断、测试任务有真实产物并通过质量检查，才允许进入正式路由。

## 8. 创建员工时每个配置怎么判断

### Instructions：决定“它做什么”

至少写清：

- 职责和非职责；
- 接受什么输入；
- 必须交付什么；
- 允许和禁止的数据范围；
- 什么时候停止并升级；
- 什么证据才算完成。

不要只写“你是一个优秀的运营专家”。这无法约束权限，也无法验收。

### Adapter：决定“谁来运行它”

- `hermes_local`：Agent军团正式 Hermes Profile 的主要按需运行方式；
- `http`：A君、小D等已有本机业务服务的受控入口；
- `codex_local`：适合代码和受控工程演练；
- `claude_local`：适合 Claude Code 本机任务；
- 其他适配器：只有现有运行时明确需要时再用。

正式岗位不要为了“能跑”随意改适配器。适配器变更会改变会话、工具、认证和工作区边界。

### Skills：决定“它按什么流程做”

- 只分配岗位真正需要的技能；
- Required skills 由 Paperclip 锁定，不能关闭；
- 外部导入技能先通读 `SKILL.md`，高权限员工尤其如此；
- 技能不存在于公司库时，先审核并导入，再分配；
- Skill 是操作说明，不是权限。权限必须由运行层阻断。

### Permissions：决定“它能改变什么”

默认拒绝：

- 普通员工不能创建 Agent；
- 普通员工不能给其他员工派任务；
- 只有明确的管理角色才能拥有组织操作权限；
- 读取私人数据、账号连接、外发、公开发布、付费、扩权必须另行审批；
- 临时授权必须限定任务、范围和有效期。

### Budget：决定“最多花多少”

Paperclip 有三层预算：

- Company：全公司的月度上限；
- Agent：单个员工的月度或终身上限；
- Project：一次性项目的终身上限。

建议：

- 警告阈值设为 80%；
- 100% 时保持自动暂停；
- 练习员工先用很小额度；
- 正式员工先跑少量代表任务，确认成本确实回传，再决定上限；
- 不要用“目前显示 0”判断免费，也不要在成本没有回传时把预算保护当成已生效。

官方给小团队的通用起点是公司每月 50–100 美元、CEO 每月 30–50 美元。这只是通用参考，不应直接复制到 Agent军团；模型订阅、本地运行和自定义适配器可能无法完整回传实际费用。

## 9. 审批怎么做

进入 **Approvals → Pending**。常见审批：

- `Hire Agent`：招聘新员工；
- `CEO Strategy`：公司总体策略；
- `Budget Override`：突破预算硬停止；
- Agent军团额外治理：扩权、账号连接、公开发布、付费、跨员工长任务、暂停/终止。

处理按钮：

- **Approve**：范围、权限、预算和后续动作都明确；
- **Request Revision**：方向可以，但配置、预算或边界需要修改；
- **Reject**：重复岗位、无真实能力、权限过大、预算不合理或目的不清。

招聘审批必须检查：

- 这个岗位现在是否真的需要；
- 是否已有员工或现成能力可以复用；
- 交付物是否可验收；
- 汇报关系是否正确；
- Adapter 和工作目录是否正确；
- Skills 是否来自可信来源；
- 是否拥有不必要的创建、派发、账号或外发权限；
- 预算和硬停止是否合理；
- 批准后是受限测试，还是已具备正式上岗证据。

普通一次性确认仍在飞书处理。改变组织能力或需要长期审计的决定，Paperclip 才是最终审批真相。

## 10. 失败时按这一条线查

```text
Paperclip 服务
→ Adapter 命令
→ 模型认证/传输
→ Agent 运行
→ 工作区和工具
→ 产物
→ 飞书或外部交付
```

操作顺序：

1. 打开员工 **Runs**；
2. 点最新失败记录；
3. 看 Events 和第一条真正错误；
4. 判断失败属于上面哪一层；
5. 修复根因；
6. 再点 `Clear error` 或 `Resume`；
7. 只运行一次无风险验证。

不要连续点 `Run Heartbeat`。`Clear error` 只清状态，不修根因。

本机出现过的例子：

```text
Command not found in PATH: "claude"
Command not found in PATH: "codex"
```

根因是 Paperclip 的 LaunchAgent 看不到 `~/.local/bin`。修复启动环境并重启后，先用 **Test environment** 验证适配器，再清错误。日志中的 fallback workspace 提示不是这次失败根因。

`blocked` 任务则先读任务评论：

- 缺输入：补材料；
- 缺决定：在评论或审批中明确选择；
- 负责人暂停：确认原因后恢复或重新指派；
- 依赖未完成：先解决最下游可执行的阻塞项；
- 能力不存在：交给架构师评估，不要反复重试。

## 11. 每天只做这五分钟

按顺序检查：

1. **Approvals → Pending**：是否有必须拍板的事项；
2. **Inbox → Blocked**：是否有缺材料、缺决定或负责人暂停；
3. **Tasks → In Progress / In Review**：是否有长时间没更新的任务；
4. **Output / Work products**：结果是否真的可读、可用、已交付；
5. **Costs / Budgets**：是否接近警告或硬停止。

没有异常就退出 Paperclip，继续在飞书找 A君办事。

## 12. 你现在最该完成的四件事

截至 2026-07-30 的本机快照：

- “Agent军团”已经存在，不需要重新创建公司或 CEO；
- 公司 Goal 仍为空，应补一个可衡量的阶段目标；
- Dashboard 当前显示 `Unlimited budget`，应先验证实际成本回传，再设置真实上限；
- 审批队列已有历史待处理项，应先逐条判断来源和有效性，不要批量批准。

建议的第一次正式操作：

1. 在 `killer` 完成一次低权限员工练习闭环；
2. 回到“Agent军团”，补一个当前里程碑 Goal；
3. 清理有效的 Pending approvals；
4. 选择一个低风险任务，走完“任务→heartbeat→产物→验收→Activity/成本”的闭环。

## 官方依据

- [What is Paperclip?](https://docs.paperclip.ing/guides/welcome/what-is-paperclip/)
- [Key Concepts](https://docs.paperclip.ing/guides/welcome/key-concepts/)
- [Agents](https://docs.paperclip.ing/guides/org/agents/)
- [Agent Adapters](https://docs.paperclip.ing/guides/org/agent-adapters/)
- [Skills](https://docs.paperclip.ing/guides/org/skills/)
- [Issues](https://docs.paperclip.ing/guides/day-to-day/issues/)
- [Work Modes](https://docs.paperclip.ing/guides/day-to-day/work-modes/)
- [Approvals](https://docs.paperclip.ing/guides/day-to-day/approvals/)
- [Costs & Budgets](https://docs.paperclip.ing/guides/day-to-day/costs/)
- [Blocked Inbox](https://docs.paperclip.ing/guides/day-to-day/blocked-inbox/)
- [Projects](https://docs.paperclip.ing/guides/projects-workflow/projects/)
- [Heartbeats & Routines](https://docs.paperclip.ing/guides/projects-workflow/routines/)
- [Activity Log](https://docs.paperclip.ing/guides/day-to-day/activity-log/)

项目内边界以 [系统架构](../architecture/system-architecture.md)、[飞书手机总管与审批分流 ADR](../adr/0005-feishu-mobile-command-and-approval-boundary.md) 和 [第一批 Agent 治理 PRD](../../tasks/prd-m2-first-batch-agent-governance.md) 为准。
