# 产品成熟度统一验证批次与 TypeScript 20% 门禁验收

| 字段 | 内容 |
| --- | --- |
| 状态 | 首批 live 批次已登记 `revision_required`；第二批门禁候选已通过本机全量验证，待冻结、切换后执行受控复验 |
| 日期 | 2026-08-10 |
| 范围 | 产品成熟度固定批次、统一验收包、21 个 Workflow 模块迁移、TypeScript 比例门禁 |

## 已实现

- 本机固定创建与统一决定 API 均要求同源 JSON、短期 owner-action nonce 和 loopback 来源。
- 三个子任务由服务端固定，使用持久化 HMAC 密钥签名；root mission、三个 child、来源、技术夹具范围、零模型合同、幂等键和 reservation 授权摘要必须完全一致，额外第四任务或未知字段失败关闭。
- 统一决定现以当前批次 `acceptanceEligible` 为硬门禁：只有本批次必需子任务全部 terminal 且 verified 时才允许登记 `accepted`；`revision_required` 保留真实失败边界，不再允许用历史成功静默替代当前批次失败。
- root mission 与三个 child 均强制本地确定性执行，已知 `0 model calls / 0 USD`；技术专家仅在 `work/acceptance-runs/` 修复受控夹具且禁止 promotion，小创禁 Advisor/Research，只引用现有确认稿和正式分析。
- 十岗位统一证据包保存 SHA-256 `evidenceHash`；固定来源真实 artifact ID、内容摘要、输出摘要、运行边界 revision 和授权摘要均进入哈希，证据变化后旧 hash 返回 409。
- Publisher、Campaign、Cron 的只读状态必须明确为关闭且带稳定 revision；状态缺失、未知或活动中时 `accepted` 失败关闭，不会自动改变这些服务。
- TypeScript 生产源码现为 `44 TS / 160 JS / 1 MJS`，比例 `44/205 = 21.46%`。
- `typescript-ratio-baseline.json` 固定最低 41 个 TypeScript 生产文件和 20% 比例；`npm run check --workspace=ajun-runtime` 同时执行严格 `tsc` 与比例门禁。

## 自动验证

旧 `8950a39…` / `4e1061c0…` 发布包曾被文档误记为根架构检查通过；该包的 `local-video-script-package.js` 实为 1198 行，按仓库 1000 行硬门禁应为 FAIL。当前候选已把来源上下文抽为 TypeScript 模块，主文件降至 933 行，并重新执行：

```text
npm run check
PASS；architecture boundaries ok；typescript ratio 44/205 (21.46%)

npm test
PASS；全部 Workspace 与根脚本测试通过

四批直接 import smoke 与对应单元测试
PASS；迁移模块均可由 Node 22 直接加载
```

这些结果只证明当前未发布候选的源码、类型、架构和本机测试通过；不能反推旧发布包通过，也不等于第二批 live 子任务已经完成。

## 首批 live 结果

- live 账本：`apps/ajun-runtime/data/product-maturity-validation-batches.json`
- 批次：`maturity-edd09036-c293-4c7b-9be4-759b817ec276`
- 统一决定：`revision_required`
- 证据哈希：`dcb2a47a2ea85f38237adc688f716e680c139904deda09b43c8b443b645387e5`
- 历史任务终态改写：`false`
- 固定来源任务：`10e4f814-8c03-4c51-ad5a-79b8328dd6e5`、`b5403cd9-ba67-457a-9fd1-d79350ea585f`

三个验证子任务的真实首批结果：

| 子任务 | 任务 ID | 真实状态 | 结论 |
| --- | --- | --- | --- |
| 创建官草案验证 | `2e4f8693-4190-4913-90b4-e66627b0098b` | `succeeded` | PASS；保持 proposal-only，没有激活岗位、没有外发 |
| 技术专家夹具修复 | `458f1461-2129-42a3-9f24-b620a68c683b` | `waiting_test` | 夹具测试与恢复检查有证据，但候选 release 门禁按 `waiting_test` 收口 |
| 小创脚本包验证 | `0709c657-b5ce-43f5-b0b4-4312844aedd1` | `succeeded` | 产出了本地脚本包，但固定来源任务被依赖来源覆盖，验收决定要求复验 |

统一决定备注原文要点：

- 创建官与小创成功；
- 技术修复测试通过，但候选 release 门禁收口为 `waiting_test`；
- 小创固定来源任务被依赖任务覆盖；
- 需先修复收口与来源合并硬门禁，再做下一次受控复验。

## 首批发现的五类缺口

1. 技术验收直通未验签缺口：首批设计里，受控技术验收链此前缺少任务级验签，普通业务上下文存在借道进入技术验收路径的风险；现已通过 HMAC 任务级绑定和技术专家入口授权校验收口。
2. 当前批次失败可能被历史成功替代缺口：首批语义上曾允许统一决定读取历史成功而弱化当前批次 `waiting_test`/失败的影响；现已改为以当前批次必需子任务状态为准，不允许历史成功静默替代。
3. `accepted` 语义缺失：首批统一决定此前没有把“本批次全部终态且 verified”做成接受硬门禁；现已补 `acceptanceEligible` 门禁，`accepted` 只能在当前批次全部满足条件时登记，`revision_required` 继续保留真实失败边界。
4. 技术修复收口缺口：技术专家子任务已经形成夹具修改、测试和恢复检查证据，但当前首批 live 结果仍以 `waiting_test` 收口，和“受控验收夹具已修复完成”的业务意图不一致；该项需在下一次受控复验中按新门禁重新验证。
5. 脚本来源与完成门禁缺口：`content.video-script-package` 首批暴露出固定历史 `sourceTaskIds` 可能被依赖来源覆盖，以及完成门禁过宽的问题；五文件、`draft_only`、`externalSideEffects=0`、两来源引用、生成前受控读取、血缘与确认稿正文校验和现已补成硬门禁。本机使用真实 `#10E4F814` 与 `#B5403CD9` 的无模型只读 smoke 已成功，仍需随下一次受控 live 批次验证运行账本口径。

## 本轮边界与未做动作

- 没有发布、外发、登录、发飞书测试消息、生成图片/音频/成片，也没有启动 Publisher、Campaign 或 Cron。
- 小创脚本包仍保持本地待审边界；`sources.md` 中“未使用可独立核验外部事实”只说明没有新增公开 research 来源，不代表允许忽略内部固定来源引用。
- TypeScript 生产比例为 `44 / 205 = 21.46%`，没有回退。

## 下一步

- 唯一下一步是：把当前 clean commit 冻结为新 immutable release，完成 4321 切换与指纹核对后，再执行第二批受控 live 复验。
- 复验仍只有固定三子任务；总政策上限保留为 4 次 / `0.08 USD`，本轮签名执行合同进一步收紧为已知 `0` 次 / `0 USD`，并保持无发布外发、无历史任务改写。

## 运行与外部边界

- 不在代码验收阶段调用模型、创建 live 批次、发送飞书消息或启动外部写入。
- 不修改历史任务终态，不读取或记录 secret、Cookie、token 或 `.env`。
- Publisher 保持关闭。

## immutable release 冻结与切换准备

只读确认当前工具边界：

- `node apps/ajun-runtime/scripts/manage-immutable-runtime-release.mjs freeze --repo-root <path> [--output-parent <path>] [--verify]`
- `node apps/ajun-runtime/scripts/manage-immutable-runtime-release.mjs plan --old-release <path> --new-release <path> --source-project-root <path> [--rollback-source-project-root <path>] --data-dir <path> --task-store json|sqlite --content-workspace-dir <path> --hermes-profile-root <path> --node-path <path> --private-dir <path> --auto-work-root <path> --xiaod-artifact-root <path> --paperclip-repair-worktree-parent <path> [--rollback-mode exact_previous|verified_degraded_fallback]`

工具已知边界与风险点：

- 该脚本只提供 freeze 和 cutover 计划，不会自动修改 plist、不会自动 `launchctl bootstrap`、不会自动重启。
- `cutover` 只有在 rollback 目标也 `ready/launchable` 时才应执行；脚本明确要求先核对旧 PID、4321 端口、cwd 和 health，再人工切换。
- `exact_previous` 目前没有内置可信 live 身份采集器与静默快照采集器；实际可启动回滚模式是 `verified_degraded_fallback`，不能把任意旧包冒充精确回滚副本。
- 切换前必须暂停入口、Cron 与 reconciler 写入，避免两个 release 并发挂载同一正式状态目录。
- 切换后必须重新核对新 PID、entrypoint、health 和 Paperclip 心跳；任一检查失败都应立即按 rollback 目标恢复。
