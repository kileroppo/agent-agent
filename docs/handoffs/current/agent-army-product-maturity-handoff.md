# Agent 军团产品成熟度总交接

| 字段 | 内容 |
| --- | --- |
| 状态 | `revision_required` / 暂停；小R防冒充成功门禁已部署并经真实 E2E 证明有效，但小R业务交付仍未通过；停止反复修复与重试 |
| 创建时间 | 2026-08-10 18:57 CST（Asia/Shanghai） |
| 最近更新时间 | 2026-08-12 07:10 CST（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | 下一位实现 Agent / 负责人 |
| 关联任务 | `docs/reviews/agent-capability-e2e-coverage-2026-08-10.md`；`docs/reviews/workflow-capability-validation-2026-08-10.md` |
| 关闭条件 | 默认不关闭、保持 `revision_required`；只有负责人将小R来源读取与建议生成重新作为独立产品问题开启，并以一次最终 E2E 通过交付门禁后，才可讨论下一轮；创建新成熟度批次仍需另行授权 |

## 接手后先做什么

- 唯一下一步：保持现状，不执行命令、不创建任务。用户已明确要求停止反复验证，以实际工作流结论为准。
- 若未来负责人明确重开：先把“两条指定来源均成功读取 + 至少三条具体 immutable-runtime 建议”作为一个独立产品缺口一次性修复，再单独授权一次最终 E2E；不得边试边扩展。
- 审核官新鲜证据已经完成，不得重复执行。最新小R任务已经终态，不得重试或复用其幂等键。
- 已决定的第二批不得再调用 create/refresh；该入口在最新批次已有决定时会创建新批。只有负责人明确授权下一轮产品成熟度复验后，才允许创建新批次。
- 不得把本轮固定 `1 mission + 3 children` 的成功改写成十岗位全部成熟，也不得用两岗的旧成功覆盖其更新的失败/待测试记录。
- 继续保持 Publisher 关闭、Campaign stopped、M5 Cron disabled；未知费用、来源、运行边界或验签任一出现时停止。

## 项目真相

- 仓库根目录：`/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent`。
- 根工作树：字幕补正与视觉恢复提交 `c93229bf409afa052930725583eb43a1561d02f1` 已推送同名远端分支；当前提交身份以 Git 实时回读为准，dirty 工作面不作发布来源。
- 正式实现工作面：`work/runtime-sources/product-maturity-ts20-20260810`，分支 `codex/product-maturity-ts20-20260810`，HEAD `64d547638f7db2760d0a9c9bc3a6067235cded08`，clean；`e10b783…` 是业务门禁提交，`64d5476…` 仅同步新增 TypeScript 文件后的版本化比例断言；尚未推送、未合入 `origin/main`。
- `docs/acceptance-fixtures/technical-repair-sandbox/calculator.js` 的加法修复已在负责人明确要求提交其余改动后纳入独立提交；后续仍不得无授权覆盖或还原。
- 当前 live A君：PID `39004`，immutable release `01b12068f23374ae1f1b8dfae85c9d4d542ef21ea0ccda425b37ff1ea1b93312`，payload `48dc755881b88295a99ac48118424d105fee8f8dde864074fe60fe9e0fa3bbcf`，Git `bbde76fd44405f5e6ed31ee3b902fc9ce48d3d75`，HTTP 4321=200；小D PID `38993`、HTTP 4318=200。该后续 release 加载字幕补正、视觉事实标记和受控识图恢复，不改变本交接的 `revision_required` 决定。
- live 指纹整体 `degraded` 来自可见根工作树与隔离发布提交不同、且 Publisher 按授权保持关闭；live release 自身为 clean，不代表本次切换失败。

## 第二批最终结果

- batch：`maturity-62d5a859-69d0-4f16-ae40-eb75aaaa0dfd`。
- mission：`89f93908-4b52-4090-a6c0-d0e187013c33`，`succeeded`，attempt 2。
- 创建官：`bde4dafc-f6cb-4cca-90c7-0258363cb744`，`succeeded`，attempt 1。
- 技术专家：`0aceff61-2c3d-43a7-b75a-a9c46f0160b6`，`succeeded`，attempt 1。
- 小创：`536587ca-c732-46f9-8be3-17f028d01c28`，`succeeded`，attempt 2。
- 固定来源：`10e4f814-8c03-4c51-ad5a-79b8328dd6e5` 确认稿；`b5403cd9-ba67-457a-9fd1-d79350ea585f` 正式视频分析。
- 四个任务均为已登记 `0 model calls / 0 tokens / 0 USD`，无 governance owner、无 Paperclip/Hermes 投影、无 Publisher/Campaign/Cron 外部副作用。
- 小创产物为 5 文件 `draft_only` 脚本包，`approvedForUse=false`、`externalSideEffects=0`，两条来源绑定精确匹配。
- 最终 evidenceHash：`40a0f43abe0c13eea39056d1239ceb9ffe4f6aa711068571f93ca101761f2cf4`。
- 最终决定：`revision_required`，时间 `2026-08-11T05:03:38.685Z`，`historicalTaskStatusesChanged=false`。
- 账本权限 `0600`，总批次数仍为 2；没有创建第三批。

### 最终证据门禁

| 门禁 | 结果 |
| --- | --- |
| 精确形状 | PASS：1 mission、3 children、0 unexpected |
| mission/child 授权与 reservation digest | PASS |
| 模型与费用 | PASS：known、0 calls、0 USD |
| 创建官草案 | PASS |
| 技术专家隔离 acceptance-only | PASS |
| 小创五文件草案与双来源绑定 | PASS |
| 三类输出 digest | PASS |
| 固定来源证据 | PASS |
| Publisher/Campaign/Cron runtime boundary | PASS |
| 第二批决定时十岗位新鲜度 | FAIL：小R、审核官当时均为 `predates_latest_failure` |
| `acceptanceEligible` | `false` |

第二批作出决定时，`intel-researcher` 的最新成功早于其后续失败，`reviewer` 的最新成功也早于其后续 `waiting_test`。固定第二批只包含 A君与三个固定子任务，不能自然刷新这两岗，因此当时的统一决定必须是 `revision_required`，不能登记 `accepted`。本次授权后审核官已取得更新的合格成功证据；小R新增失败，所以旧决定仍不改写。

## 本次授权后的新鲜证据进展

- 审核官第一次真实任务 `6079067f-392f-4346-819e-c6e7b4701bc5` 虽成功，但 Paperclip 投影遗漏了安全的结构化 scope/tool/budget，报告只能判定上下文缺失；该任务不计入新鲜验收证据。
- `53b526ba… / 3f695658…` 增加审核任务安全白名单投影，只允许 scope、公开数据范围、工具白名单、预算、有效期、无副作用和审批策略，不投影未知字段或 secret。替代任务 `c28bcab5-1868-40c0-a3fb-4c88ce8c03d6` 随后成功，明确核对全部边界并给出 `approve_for_owner_decision`；这是一条晚于旧 `waiting_test` 的审核官新鲜成功证据。
- 小R真实任务 `90eca882-f896-46c8-b093-d6e0b47f8e58` 只读访问 `https://nodejs.org/api/process.html` 与 `https://nodejs.org/api/cli.html#environment-variables`。两页均有抓取时间和内容哈希，但旧提取器让导航占满 30,000 字符窗口，摘要只剩标题片段；任务按证据不足以 `paperclip_hermes_reported_failure` 结束，没有编造结论。因此它成为小R新的最新失败，尚不能刷新 freshness。
- `41bd55d…` 已冻结为 release `9257a7b0…`（payload `246bc482…`）并切到 PID `50337` live；单一 4321 listener、cwd、manifest、A君/Paperclip HTTP 200 均已回读。
- 本次唯一小R重试任务 `b614bb54-d4cf-4f77-ba5c-e05a10275b2e` 复用两条 Node.js 官方公开来源。调用后立即对账增量为 `7 calls / 0.004812125 USD`，低于授权的 `8 calls / 0.015 USD`，unknown=0。
- 该任务数据库终态虽为 `succeeded / paperclip_hermes_completed`，但岗位回报明确承认只提取到页首介绍与 `--run` 变量片段，未覆盖 `SIGTERM/SIGINT`、exit 行为、`process.env`，也未产出三条 immutable-runtime 建议。因此业务验收为 FAIL CLOSED，不计为小R新鲜成功证据。
- commit `e10b783…` 新增独立 TypeScript 交付门禁：成熟度小R任务必须预先声明 1–8 个必需证据词与建议数；摘要会按词抽取网页后段证据片段；缺合同、缺证据或缺交付数均转 `needs_input/waiting_test`；Paperclip 文字回报不能覆盖；本次旧 `succeeded` 记录也不得进入成熟度 verified 矩阵。该门禁已随 `64d5476… / 530d86bf…` 部署。
- 门禁版真实任务 `2cb79a68-c09b-40d4-8458-68b68a2e6467`（Paperclip Issue `41aa472c-c1d2-41b1-9ffd-e05fd6fd3629`）按一次运行、最多 8 calls / 0.015 USD 创建；没有创建成熟度批次。
- 该任务预先要求覆盖 `Event: 'exit'`、`SIGTERM`、`SIGINT`、`process.env`、`NODE_OPTIONS` 并至少给出三条建议。最终只读取到 `process.html` 一条来源，覆盖前四项中的 `exit/SIGTERM/SIGINT/NODE_OPTIONS`，缺 `process.env`；建议数 1/3。因此终态为 `waiting_test / paperclip_hermes_waiting_test`，交付门禁 `accepted=false`。这证明防冒充门禁有效，但不证明小R业务能力合格。
- 任务完成窗口相对基线增加 7 API calls，估算费用增加 `0.005862007 USD`，低于 8 calls / 0.015 USD；当前全局窗口为 134 entries / 947 API calls / 已知估算 `0.691708472 USD` / unknown=0。Publisher、Campaign、M5 Cron 未被本任务启用；成熟度账本仍恰好 2 批，没有第三批。
- 用户随后明确要求停止这种逐层修复、逐层重试的循环，并以真实工作流为标准。当前 durable decision 是停在 `revision_required`，不继续自动诊断、修复、部署或重试。

## 实际恢复与发布经过

1. `8950a39… / 4e1061c0…` 首批账本登记 `revision_required`。旧文档曾把 `npm run check:architecture` 写为 PASS，这是误报：该版本 `local-video-script-package.js` 为 1198 行，超过生产源码 1000 行硬门禁，实际应为 FAIL。后续抽取来源上下文后才重新通过。
2. `eb0f9bb… / a8d10e3f…` 创建第二批；首次响应中断写成 `creation_unknown`，重试复用同一 batch，没有重复 mission。真实链路随后暴露技术子任务长期 `queued`。
3. `4df8032… / 77029b21…` 以同一 technical task ID 恢复成功；随后同一 content child 因原型方法被对象展开丢失而进入 `waiting_test`，错误为 `this.research is not a function`。
4. `ebcb678… / d89c550b…` 保留双层原型并加入精确 CAS/崩溃窗口恢复；同一 content 和 mission ID 均以 attempt 2 成功，四任务全部终态且为 0 调用/0 费用。
5. 最终 refresh 暴露验收器错误读取 Paperclip 的 nested 技术结构。`d7b3b1c… / 4150a8d3…` 改为只接受本地技术专家 canonical `execution.verification`，拒绝 nested fallback；同批最后一次 refresh 后 `technicalAcceptanceOnly=true`，随后登记 `revision_required`。
6. `41bd55d… / 9257a7b0…` 修复 Node.js 长文档正文选择并完成受控重试；真实返回又暴露摘要只取前三句、通用完成门禁不核对交付覆盖的问题。
7. `e10b783… + 64d5476… / 530d86bf…` 关闭该假成功路径并于 2026-08-11 15:37 CST 切入 live。
8. 真实任务 `2cb79a68…` 在新门禁下如实停在 `waiting_test`；它暴露的是业务能力仍缺“两条来源完整读取 + 三条具体建议”，不是继续自动重试的理由。用户决定停止循环。

## 验证账本

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 代码 | PASS | `64d5476…`：全量 `npm test` 通过；抽取 TypeScript 协作者后定向 50/50 + Paperclip 集成 1/1；`npm run check`、architecture、tsc、`git diff --check` 通过 | 自动化不代表小R业务 E2E 已通过 |
| TypeScript 比例 | PASS | `47/208 = 22.60%`；`local-intel-researcher.js` 已回落到 901 行 | 仍按风险边界渐进迁移，不做机械改名 |
| 冻结包 | PASS | release `530d86bf…` / payload `f20f4fc0…` / Git `64d5476…` clean，7218 entries；source/central manifest、main/recovery smoke、static closure、payload/source binding 均通过 | recovery 为只读降级，不是 exact previous |
| live 身份 | PASS（授权版本） | PID 94582；release 530d86；payload f20f4f；Git 64d5476；单一 4321 listener；4321/Paperclip 200；source/live same_git_head | Publisher 故意关闭使整体指纹 degraded |
| 固定批次 E2E | PASS | 同一 1+3 全部 succeeded；0 calls/0 USD；来源、产物、授权、草案和 runtime boundary 全通过 | 只证明固定批次，不证明小R/审核官新鲜度 |
| 小R门禁版真实 E2E | FAIL CLOSED（门禁行为 PASS） | 任务 `2cb79a68…` 终态 `waiting_test`；5 个证据词缺 `process.env`，建议 1/3，只读取 1/2 来源；7 calls / 估算 0.005862007 USD | 门禁阻止假成功，但业务报告未达标；不再重试 |
| 统一产品成熟度 | REVISION REQUIRED | 已决定批次 evidenceHash `40a0f43a…`；审核官后续已有新鲜成功，小R最新真实任务仍失败关闭 | 默认保持现状；新批仍需另行授权 |
| 人工内容采用 | 未替代 | `#B5403CD9` 仍是独立人工内容判断 | 本批机器证据不等于负责人采用内容 |

## 运行与外部边界快照

检查时间：2026-08-12 07:10 CST，动态事实接手时仍须重验。

- A君：PID 39004，4321 HTTP 200，release 01b12068 / payload 48dc755 / Git bbde76f；可见根工作树与隔离发布提交不同，release 自身 clean。
- Paperclip：HTTP 200；最新只新增一条小R任务 `2cb79a68…`，现为 `waiting_test`；没有把 Paperclip 本机任务同步表述为外部发布。
- Publisher：4390 无 listener，launchd disabled。
- Campaign：唯一活动记录保持 `stopped`，无 active run。
- M5 Cron：2 条 schedule 均 disabled，enabled=0。
- Hermes billing：当前窗口 134 entries、947 API calls、已知估算总额 `0.691708472 USD`、unknown=0。最新小R任务的完成窗口差分为 7 calls / 估算 `0.005862007 USD`。固定第二批四任务仍为 deterministic-local 0 用量记录。
- 以上费用总额包含历史窗口；本次新鲜证据工作与固定成熟度第二批必须分账，后者仍为 0 USD。

## 风险、权限与关闭门禁

- 决定后的第二批不可再调用 create/refresh；后续查询只读账本或安全投影。
- 不允许为“补齐矩阵”改写历史终态或放宽 freshness；新证据必须晚于各岗最新失败/待测试记录。
- 审核官 E2E 已完成，不再重复。小R新门禁 E2E 已诚实失败，不再继续自动修复或重试；若负责人未来重开，必须作为独立产品修复重新声明范围、费用和唯一一次最终验收。
- 不读取或回显 secret、token、Cookie、`.env`；本轮 owner nonce 未落盘、未写入文档。
- 不启动 Publisher、不恢复 Campaign、不启用 M5 Cron、不自动发布或外发。
- 当前 rollback 仅为 `verified_degraded_fallback / local_recovery_only / no_external_state_access`，不得表述为完整 `exact_previous`。
- 字幕补正与视觉恢复提交 `c93229b` 已按明确范围推送；产品成熟度专用实现分支仍须按其自身状态核对，不得把根工作树其他 dirty baseline 混入后续提交。

## 推荐技能

- `handoff`：换会话时保留“默认停止、不得自动重试”的唯一下一步。
- `code-review-and-quality`：复核新证据是否晚于失败、是否绑定真实产物与当前运行时。
- `browser-testing-with-devtools`：仅在负责人授权真实外部页面/飞书验收后使用，不得绕过账号或权限边界。
