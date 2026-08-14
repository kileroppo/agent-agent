# 为 Agent 军团新增贴合开发者的岗位（小G + 小R）— GPT 执行规格

> 本文件是一份**自包含实施规格**，交给 GPT（或其他工程 AI）在本机仓库直接执行。执行者没有原始对话上下文，请严格按本文操作。

## Context（为什么做这件事）

负责人看到亦仁「生财有术」Agent 军团截图（30+ 岗位，分 组织部/数据组/内容组/管理组/运营组/实战组），想做类似的，但明确要求"不是无脑照搬，而是根据我的情况搭建适合我的"。

负责人是**单人开发者**，当前仍在开发阶段、几乎没真实使用。亦仁那套围绕内容社区生意，内容组/运营组/管理组对单人开发者基本是空壳——这也是项目 PRD 的非目标（"不为匹配截图一次性创建 30 个空壳 Agent"）。因此本次只建两个真正会用、且能复用现有能力的岗位。

现状差距：组织部（架构师/运维官/审核官/技术专家）已齐；数据组只有小D（视频）+ 公开资料报告员（≈网页检索）；实战组/内容组/管理组/运营组基本空白。

## 目标（本次交付）

**小G · GitHub 检索（数据组）**：
1. 按需搜项目：给关键词/需求，搜公开 repo，按 star、活跃度、语言给中文评估
2. 读代码/找方案：读某个公开 repo 的 README 或指定文件，回答"它怎么实现 X"
（"盯 release/更新"= 监控类，放 Phase 2，本次不做）

**小R · 情报研究者（实战组）**：围绕一个主题综合多个公开来源，产出**结构化研究报告**（背景 / 关键发现 / 结论 / 行动建议 / 未决问题）。与报告员的区隔见 Phase 1B。

## 关键复用（已确认的现有实现，务必仿照）

- 执行器模式：`apps/ajun-runtime/src/local-public-report.js`（`LocalPublicReport`：fetch → summarize → 产出 artifact）
- HTTP 通道：`apps/ajun-runtime/src/public-web-transport.js`（HTTPS、不跟跳转、20s、~1MB 限制）—— GitHub API 返回 JSON，单次 HTTPS 请求，天然适配
- 工具模式：`apps/ajun-runtime/src/public-web-fetch.js`
- AI 顾问模式：`apps/ajun-runtime/src/hermes-public-comparison-advisor.js`
- 岗位结构模板：`agents/xiaod/`、`agents/av-transcriber/manifest.json`
- Hermes Profile 模板：`integrations/hermes/profiles/ajun.profile.json`
- 注册（自动扫描 agents/ 目录）：`apps/ajun-runtime/src/agent-registry.js`
- 执行器挂载：`apps/ajun-runtime/src/server.ts` 的 `TaskService({ executors: {...} })`
- 路由：`apps/ajun-runtime/src/feishu-commander.js` + `hermes-intent-planner.js`
- 契约校验：`agents/test/agent-manifest.test.mjs`

## 执行者前置说明

- 仓库根：`/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent`（macOS，Node ESM，测试用内置 `node:test`）
- 主运行服务：`apps/ajun-runtime`（端口 4321，LaunchAgent `ai.agent-army.ajun-runtime` 常驻）
- 改代码后重启：`launchctl kickstart -k gui/$(id -u)/ai.agent-army.ajun-runtime`
- 治理：新增岗位 manifest `status` 先 `draft`，经审核官/受限测试后由负责人置 `active`。**不要直接写 `active`。**
- 安全红线：只读公开 GitHub / 公开网页，绝不带 token/凭据，不外发、不发布、不付费。凭据不得进入代码、日志、测试快照。

## 前置步骤 0（必做，先于一切）

1. 修复已知失败单测：`apps/ajun-runtime/test/feishu-commander.test.js:188`（用例"飞书军团总管将小D请求保留为同一飞书事件任务"）。当前实际返回 `"小D尚未开始处理：任务还没有正确路由到小D。"`，期望匹配 `/已交给小D/`。定位 `feishu-commander.js` 中媒体任务的回复文案/路由，使 `cd apps/ajun-runtime && npm test` 全绿（应为 278/278）。
2. `git add -A`（`.env` 已被 .gitignore 排除）并 commit 一次，建立干净基线。
3. 确认 `node agents/test/agent-manifest.test.mjs` 通过。

---

## Phase 1A — 小G · GitHub 检索（数据组）

### 步骤 1：岗位定义

新建 **`agents/github-scout/manifest.json`**：
```json
{
  "schemaVersion": "agent.army/v1",
  "manifestVersion": "0.1.0",
  "agentId": "github-scout",
  "name": "小G",
  "department": "数据组",
  "role": "按需检索公开 GitHub 项目、评估活跃度并读取公开代码/README 回答技术问题。",
  "responsibilities": [
    "根据关键词或需求搜索公开 GitHub 仓库，按 star、活跃度、语言给出中文评估",
    "读取指定公开仓库的 README 或公开文件，回答\"它怎么实现 X\"",
    "如实说明搜索无结果、API 限流或仓库不可读，不编造结论"
  ],
  "nonResponsibilities": [
    "不使用任何 GitHub token、登录态或私有仓库访问",
    "不 clone、执行、下载可执行文件或写入任何外部系统",
    "不外发、不发布、不付费、不做未批准的扩权动作"
  ],
  "acceptedTaskTypes": ["research.github-search"],
  "toolAllowlist": ["github.public.search", "github.public.read"],
  "dataScopes": [{ "scope": "public-github-metadata", "access": "read" }],
  "approvalPolicies": [
    { "action": "any-authenticated-or-write-github-access", "riskLevel": "high", "decision": "require-approval" }
  ],
  "qualityGates": [{ "gate": "sources-have-public-url-and-fetched-at", "required": true }],
  "budgetPolicy": { "maxAttempts": 2, "maxRuntimeMinutes": 5, "onLimit": "stop-and-report" },
  "promptRef": "agents/github-scout/prompts/system.md",
  "runtimeProfileRef": "integrations/hermes/profiles/github-scout.profile.json",
  "appRef": "apps/ajun-runtime",
  "operationalPolicy": { "heartbeatSeconds": 0, "inputTimeoutMinutes": 10, "retryStrategy": "single-safe-retry" },
  "owner": "A 君",
  "status": "draft"
}
```
- `agents/github-scout/prompts/system.md`：岗位边界（只读公开 GitHub、中文输出、限流时如实说明）。
- `agents/github-scout/岗位卡.md`：仿其他岗位卡的中文说明。

### 步骤 2：Hermes Profile
新建 **`integrations/hermes/profiles/github-scout.profile.json`**（对齐 `ajun.profile.json`）：`profileId:"github-scout"`、`gateway.enabled:false`、`secrets.valuesStoredHere:false`、`agentManifestRef`/`promptRef`/`appRef` 指向上面文件。

### 步骤 3：工具 `apps/ajun-runtime/src/github-search.js`
仿 `public-web-fetch.js`，注入 `fetchImpl`（复用 `PublicWebTransport`）。导出 class `GithubSearch`：
- `async search({ query, limit = 5 })` → GET `https://api.github.com/search/repositories?q=<query>&sort=stars&order=desc&per_page=<limit>`，Header `Accept: application/vnd.github+json`、`User-Agent: agent-army-github-scout`。返回 `{ query, searchedAt, results:[{ fullName, description, stars, language, updatedAt, url, topics }] }`。
- `async readRepo({ repo, path = 'README' })` → 默认读 README：GET `https://api.github.com/repos/<repo>/readme`（base64 content 解码为文本）；指定 path 时读 contents API。文本按 transport 限额截断，返回 `{ repo, path, text, truncated, fetchedAt }`。
- 限流（HTTP 403 + `X-RateLimit-Remaining: 0`）或网络失败：抛带 `code` 的错误（`github_rate_limited`、`github_unavailable`），由执行器转成 `needs_input`/可重试。
- 不带任何 Authorization header。

### 步骤 4：执行器 `apps/ajun-runtime/src/local-github-scout.js`
结构完全仿 `LocalPublicReport`：
- `constructor({ githubSearch, now })`
- `supports(agent)` → `agent?.agentId === 'github-scout'`
- `async execute(task)`：
  - 输入 `task.input`：`{ query }`（搜项目）或 `{ repo, path }`（读代码），按字段区分。
  - 搜项目：调 `githubSearch.search`，整理成中文评估（star/语言/最近更新/一句话点评），产出 artifact `type:"research_github_report"`。
  - 读代码：调 `githubSearch.readRepo`，摘要 README 关键段，产出 artifact `type:"github_code_read"`。
  - 无结果/限流：`status:'needs_input'`，`userMessage` 如实说明并建议稍后重试或换关键词（照抄报告员错误对象结构 `code/userMessage/category/stage/occurredAt`）。
  - 成功：`status:'succeeded'` + `execution` + `usage.tools`（记录 `github-public-search`/`github-public-read` 调用次数）+ `artifactRefs`（含 `validation:{exists,readable,nonEmpty,publicReadOnly:true}`）。

### 步骤 5：挂载执行器（`apps/ajun-runtime/src/server.ts`）
- import `GithubSearch`、`LocalGithubScout`。
- `const githubSearch = new GithubSearch({ fetchImpl:(...a)=>publicWebTransport.fetch(...a) });`
- `TaskService({ ... executors:{ ..., 'github-scout': new LocalGithubScout({ githubSearch }) } })`。

### 步骤 6：路由
- `hermes-intent-planner.js`：新增动作 `github_search`（"在公开 GitHub 上搜项目或读某个公开仓库的代码/README"）。
- `feishu-commander.js`：GitHub 意图 → `tasks.create({ taskType:'research.github-search', assigneeAgentId:'github-scout', source:{ eventRef }, input:{ query 或 repo } })`；回执"已交给小G检索"；沿用报告员的原会话回执/完成跟进链。

### 步骤 7：测试（`node:test`，mock fetch，勿真实联网）
- 新增 `test/github-search.test.js`：mock fetchImpl 固定 JSON，断言解析；mock 403 断言抛 `github_rate_limited`。
- 新增 `test/local-github-scout.test.js`：搜项目/读代码两条产出结构、限流转 needs_input、不编造。
- `test/feishu-commander.test.js`：加"GitHub 意图路由到 github-scout 且回执含'小G'"。
- `agents/test/agent-manifest.test.mjs` 自动覆盖新 manifest。

---

## Phase 1B — 小R · 情报研究者（实战组）

### 与报告员的区隔（务必守住）
- 报告员（`local-public-report.js`）：读 1–5 条公开网页，逐条摘要 + 基础对比。**浅、快、面向"读这几个页面"。**
- 小R：**主题驱动**。输入一个研究主题（可选附来源），组织多来源（可调用小G搜 GitHub、公开网页读取），产出**结构化研究报告**：背景 / 关键发现 / 结论 / 行动建议 / 未决问题。面向"帮我把某主题研究清楚"。

### 步骤 8：岗位定义
`agents/intel-researcher/manifest.json`（同小G模板改）：`agentId:"intel-researcher"`、`name:"小R"`、`department:"实战组"`、`role:"围绕一个主题综合多个公开来源，产出结构化中文研究报告"`、`acceptedTaskTypes:["research.intel-report"]`、`toolAllowlist:["content.public.fetch","github.public.search","github.public.read"]`、dataScopes 只读公开、status `draft`。附 `prompts/system.md`、`岗位卡.md`。
`integrations/hermes/profiles/intel-researcher.profile.json`（同小G Profile 模板）。

### 步骤 9：AI 综合顾问 `apps/ajun-runtime/src/hermes-intel-research-advisor.js`
仿 `hermes-public-comparison-advisor.js`：输入 `{ topic, sources:[{title,source,summary}] }`，输出 `{ background, findings:[], conclusion, recommendations:[], openQuestions:[] }`。**只依据传入的已读取内容**；AI 不可用时降级为按结构罗列各来源要点（照抄报告员 fallback 思路）。

### 步骤 10：执行器 `apps/ajun-runtime/src/local-intel-researcher.js`
- `constructor({ publicWebFetch, githubSearch, researchAdvisor, now })`
- `supports(agent)` → `agent?.agentId === 'intel-researcher'`
- `execute(task)`：输入 `{ topic, sourceUrls?[] }`。给了 URL 就读；否则用小G/公开搜索补 3–5 条来源（沿用报告员"没链接自己找"的保守限额）。读完调 `researchAdvisor` 生成结构化报告，产出 artifact `type:"intel_research_report"`（含 sources、结构化字段、usage.tools）。来源为空/全失败转 `needs_input`，不编造。

### 步骤 11：挂载 + 路由
- `server.js`：`executors['intel-researcher'] = new LocalIntelResearcher({ publicWebFetch, githubSearch, researchAdvisor:new HermesIntelResearchAdvisor() })`。
- `hermes-intent-planner.js` 新增动作 `intel_research`；`feishu-commander.js` 路由到 `research.intel-report` / `intel-researcher`，回执"已交给小R研究"。
- 意图区分：研究某主题/给结论→小R；在 github 找项目/读某仓库→小G。AI 拿不准时按报告员追问策略问一句，不硬猜。

### 步骤 12：测试
- `test/hermes-intel-research-advisor.test.js`：mock 顾问返回结构化字段 + AI 不可用降级。
- `test/local-intel-researcher.test.js`：给定来源产出结构化报告；无来源/失败转 needs_input。
- `test/feishu-commander.test.js` 加小R路由用例。

---

## 验收账本
在 `docs/reviews/m2-real-small-army/acceptance.md` 新增两条，先记"待人工验收"：
- **ARMY-039**：小G 从真实飞书搜 GitHub 项目并在原会话交付中文评估 + 可点击 repo 链接。
- **ARMY-040**：小R 从真实飞书就一个主题产出结构化研究报告，来源可点击、不编造。

## 验证方式（端到端）
1. `cd apps/ajun-runtime && npm test` → 全绿（278 + 新增用例）。
2. `node agents/test/agent-manifest.test.mjs` → 两个新 manifest 通过契约。
3. 重启服务，`curl -s http://127.0.0.1:4321/api/overview` 应能看到小G、小R（active 前显示为草案/准备中）。
4. 本机造任务验证执行器：小G 造 `research.github-search`，小R 造 `research.intel-report`，确认 artifact 结构正确、限流/无结果如实报错。
5. 治理流程：两岗位先 `draft` → 审核官检查权限 → 受限测试通过 → 负责人置 `active`（对齐 US-M-006）。
6. 真实飞书：分别发"帮我在 github 找几个做 X 的开源项目"和"帮我研究一下 X 这个主题，给结论和行动建议"，确认原会话正确路由并交付 → ARMY-039 / ARMY-040。

## 后续阶段（本次不做）
- **Phase 2（信息监控）**：小G 加"盯 release/更新"——watch-list 持久化（`data/` 下 JSON）+ 复用 `integrations/paperclip/scripts/ensure-operations-health-routine.mjs` 定时巡检模式，有新版本主动回原会话。
- **Phase 3（内容组/管理组，默认不做）**：仅当出现真实内容生产或项目管理需求、且频率足够时才建；个人/项目管理优先复用现有 Paperclip。

## 不做的事
- 不一次性照搬亦仁 30 个岗位
- 不给小G/小R 任何登录态/token（只读公开）
- 不加外发、发布、付费能力
- 不跳过 draft→审核→受限测试→active 治理流程直接上线
