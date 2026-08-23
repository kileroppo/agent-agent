# Agent军团仓库协作规则

## 先读入口

开始工作时，先按任务大小判断需要读取的材料，不为遵守流程而扩大阅读范围或创建无价值文档：

| 任务情况 | 必读内容 | 是否需要交接单 |
| --- | --- | --- |
| 明确的小修复、文案或链接改动 | 本文件与受影响文件 | 不需要 |
| 当前里程碑内的实现、调试或设计变更 | 本文件、`README.md`、当前里程碑 PRD、相关架构/契约 | 仅在需要换人、换会话或留下未完成风险时需要 |
| 飞书、Hermes、Paperclip、运行服务或其他外部平台 | 上述内容，加相关集成文档和验收记录 | 通常需要，尤其尚未完成真实验证时 |
| 新功能、范围/架构变化或新里程碑 | 上述内容，加总 PRD 与文档治理规范 | 需要先确认是否已有有效交接单；必要时创建或更新 |

中大型改动的默认阅读顺序：

1. `README.md`：当前阶段和正式入口；
2. `tasks/prd-agent-army-master.md`：长期目标与边界；
3. 当前里程碑 PRD；
4. 受影响的架构、契约、设计和规范。

小而明确的局部修复直接处理，不需要为了流程新增文档。

## 代码边界

- 业务 Agent 放在 `apps/`；岗位定义放在 `agents/`；平台接入放在 `integrations/`。
- 飞书、Paperclip、Hermes 通过适配层接入，业务逻辑不得直接依赖平台 SDK。
- 只有两个以上真实消费者时才提取 `packages/` 公共模块。
- 不删除现有能力来换取表面简洁；按真实工作流分组和渐进披露。
- 不把聊天展示状态当作任务真相，不把部分成功标记为完整成功。
- **复用优先**：准备新增军团控制台、任务队列、调度、预算、审批、审计、Agent 运行时或通用连接器前，必须先检索官方文档、源码与本机已安装能力；若已有可用产品或模块，优先用适配层接入。只有现成能力明确缺失且属于本项目业务边界，才自研最小缺口；不得复制 Paperclip 等现成平台的控制面。
- **能力检索顺序**：新增功能前先查本仓库和技能库/已安装 CLI；没有再查官方文档、源码、GitHub 或公开网络的成熟实现；只有功能确实缺失且规模可控时才自研。不得为已有工具覆盖的问题另造平行实现。

## 规模化原则

- 先用清晰的任务边界、权限、质量门禁、成本上限和失败恢复换取确定性；只有这些前提可控后，才扩大并发 Agent、任务量或模型调用规模。
- Token 消耗不是目标。只为可验收的业务价值调用模型，并在失败、重复或超过预算时停止扩张、回到问题定位。
- 里程碑门禁以 `README.md`、当前里程碑 PRD 和验收记录为准；不得用历史 M1 目标阻止已授权的 M2 或后续工作，也不得用“多 Agent”“高并发”替代当前里程碑的真实验收。

## 安全

- 不读取、回显、复制或提交真实 `.env` 内容。
- secret、token、Cookie、授权链接不得进入代码、文档、Prompt、日志或测试快照。
- 外发、公开发布、敏感访问、扩权和高成本动作需要明确授权与审批。

## 完成标准

- 运行与测试结果必须事实化描述，未验证的外部能力明确标记未验证。
- 涉及界面时验证关键状态和真实操作路径。
- 涉及本地服务时核对进程、端口和工作目录。
- 完成里程碑前同步 PRD、README、架构/契约和验收记录。
- 文档门禁与灵活边界见 `docs/governance/document-lifecycle.md`。
- 发生换人、换会话、未完成外部验证或里程碑阶段切换时，按 `docs/handoffs/README.md` 创建或更新交接单；明确小改动不强制创建。
- 交接时先读 `docs/handoffs/README.md` 和 `docs/handoffs/HANDOFF-TEMPLATE.md`，在 `docs/handoffs/current/` 创建或更新交接单。交接单只记录可验证事实，必须写明唯一下一步、继续条件、验证账本、风险和关闭条件；不得记录凭据。

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
