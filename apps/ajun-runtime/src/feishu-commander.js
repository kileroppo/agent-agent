import { formatPublicReportReply } from './public-report-presentation.js';
import { formatOfficeBriefingReply } from './local-office-assistant.js';
import { resolveAnalysisIntent } from './analysis-intent.ts';
import { validateTaskCompletion } from './task-completion-contract.js';

// Allow the user to name the new role between “创建一个” and “Agent”, such as
// “创建一个公开网页摘要 Agent”.  The previous expression only recognised an
// immediate “Agent”, so normal named requests were sent to the generic intake.
const CREATE_AGENT_RE = /(?:创建|新建|招募|招)\s*(?:一个\s*)?.{0,80}?(?:agent|智能体|岗位|助手)/i;
const PROGRESS_RE = /进度|进展|做到哪|处理得怎么样|完成了吗|结果呢|任务状态/;
const USAGE_RE = /花了多少|花费|成本|费用|消耗|用量|token|账单|开销|实际使用/i;
const FOLLOW_UP_RE = /^(?:需要|处理|继续|好的|好|行|可以|开始)$/;
const PAUSE_RE = /(?:暂停|先别做|先停)/;
const RESUME_RE = /(?:恢复|继续).*(?:任务|处理|执行)|^(?:继续|恢复)$/;
const RETRY_XIAOD_RE = /^\s*重试\s*小\s*D\s*任务(?:\s+[0-9a-f-]{8,})?\s*$/i;
const CONTINUE_XIAOD_DELIVERY_RE = /^\s*(?:继续|重试)\s*飞书交付(?:\s+[0-9a-f-]{8,})?\s*$/i;
const POSITIVE_FEEDBACK_RE = /(?:不错|满意|有用|很好|挺好|做得好|谢谢|辛苦了)/;
const NEGATIVE_FEEDBACK_RE = /(?:不行|不对|有问题|重做|重新做|改一下|需要改进|没用|不好)/;
const HEALTH_RE = /健康|状态|服务|运行|paperclip|检查系统/i;
const CAPABILITIES_RE = /(?:你|军团|现在).*(?:能干什么|能做什么|可以做什么|能帮我什么|有什么能力)|(?:能干什么|能做什么|可以做什么|能帮我什么|有什么能力).*(?:你|军团|现在)?/i;
const OPERATIONS_TRIAGE_RE = /(?:怀疑|担心|看看|查(?:一下|下)?|检查|判断).{0,48}(?:异常|故障|出问题|卡住|卡死)|(?:异常|故障|出问题|卡住|卡死).{0,80}(?:安全(?:处理|恢复)|谁(?:来|该)接手|怎么处理|需要我做什么)/i;
const MEDIA_RE = /视频|音频|转录|字幕|整理素材|youtube|bilibili|抖音|快手|transcri/i;
const VIDEO_SCRIPT_RE = /(?:写|生成|做|出).{0,20}(?:视频)?(?:脚本|口播稿|拍摄稿)|按.{0,40}(?:套路|结构|视频|案例).{0,40}(?:写|生成|做|出)|(?:脚本|口播稿).{0,40}(?:主题|关于)/i;
const VIDEO_ANALYSIS_MODE_RE = /总结|提炼|精华|快速看懂|重点是什么|深度拆解|完整分析|完整拆解|为什么有效|学习方法|13\s*模块|模板学习|提取模板|学习模板|复用结构|开头套路|填空模板|换种风格|风格探索|专业版|幽默版|故事版|数据版/iu;
const USE_THIS_VERSION_RE = /^\s*(?:用这版|就这版|采用这版|按这版做|这版可以)\s*[。！!]?\s*$/;
const SCRIPT_REVISION_RE = /(?:更像我|更口语|更自然|节奏快|节奏慢|短一点|长一点|改(?:一下|成)|重写|开头.{0,12}(?:换|改)|语气.{0,12}(?:换|改))/i;
const OFFICE_RE = /办公汇报|汇报包|整理成(?:文档|表格|清单)|任务清单|会议材料|会议纪要|把.{0,40}(?:结果|材料).{0,20}整理/i;
const TASK_ID_RE = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i;

export class FeishuCommander {
  constructor({ tasks, proposals, missions = null, store, planner = null, conversationAdvisor = null, ajunBaseUrl = null } = {}) { this.tasks = tasks; this.proposals = proposals; this.missions = missions; this.store = store; this.planner = planner; this.conversationAdvisor = conversationAdvisor; this.ajunBaseUrl = safeLoopbackBaseUrl(ajunBaseUrl); }

  async handle(input) {
    const text = String(input?.text || '').trim();
    const sourceEventRef = String(input?.sourceEventRef || '').trim();
    if (!text) throw new FeishuCommanderValidationError('飞书消息不能为空。');
    if (!sourceEventRef) throw new FeishuCommanderValidationError('飞书消息缺少稳定事件引用，未创建任务。');
    const targetAgentId = safeAgentId(input?.targetAgentId);
    const source = { channel: 'feishu', eventRef: sourceEventRef, chatRef: safeRef(input?.chatRef), ...(targetAgentId ? { targetAgentId } : {}) };
    const requester = { kind: 'feishu-user', ref: safeRef(input?.requesterRef) || 'feishu-requester' };
    const direct = await this.handleDirectAgent(targetAgentId, { text, sourceEventRef, source, requester });
    if (direct) return direct;
    if (USE_THIS_VERSION_RE.test(text)) return this.approveLatestVideoScript({ sourceEventRef, source, requester });
    if (SCRIPT_REVISION_RE.test(text)) {
      const revision = await this.reviseLatestVideoScript({ text, sourceEventRef, source, requester });
      if (revision) return revision;
    }
    // A君 owns URL-created media work and its recovery chain.  Do not let the
    // old direct-Xiaod retry phrase fall through to a generic LLM conversation.
    if (CONTINUE_XIAOD_DELIVERY_RE.test(text)) return this.continueXiaodDelivery(source.chatRef);
    if (RETRY_XIAOD_RE.test(text)) return this.retryXiaodTask(source.chatRef);
    // A progress question, a pasted task ID, or "小D 的进度" is a lookup of
    // facts already in this chat. Never send it to the model for a vague reply.
    const progressQuery = progressQueryFor(text);
    if (progressQuery) return this.taskProgress(source.chatRef, progressQuery);
    const pendingLinkResult = await this.handlePendingLink(text, { sourceEventRef, source, requester, targetAgentId });
    if (pendingLinkResult) return pendingLinkResult;
    // An explicit question about one named employee is a factual lookup, not
    // an open-ended chat turn. Resolve it before conversation/intent models so
    // “小D目前在干嘛” cannot degrade into a generic clarification.
    const explicitEmployeeStatus = await this.explicitEmployeeStatus(text);
    if (explicitEmployeeStatus) return explicitEmployeeStatus;
    // 短确认、暂停和评价必须依赖当前任务真相，不能交给模型猜。
    // 其他正常中文先交给 AI 理解；旧关键词只在 AI 临时不可用时兜底。
    const control = conversationControlIntent(text);
    if (control) return this.handlePlannedIntent(control, { text, sourceEventRef, source, requester, targetAgentId });
    const contextual = await this.contextualUnderstanding(text, source.chatRef);
    if (contextual?.reply) return contextual.reply;
    if (contextual?.plan) return this.handlePlannedIntent(contextual.plan, { text, sourceEventRef, source, requester, targetAgentId });
    const plan = await this.intentFor(text);
    return this.handlePlannedIntent(plan, { text, sourceEventRef, source, requester, targetAgentId });
  }

  async handleDirectAgent(agentId, { text, sourceEventRef, source, requester }) {
    if (!agentId || agentId === 'ajun') return null;
    if (agentId === 'reviewer' && isRegisteredDraftReviewRequest(text)) return this.reviewRegisteredDrafts(text);
    const directPlan = await this.directAgentIntent(agentId, text);
    if (directPlan?.intent === 'identity') return directAgentIdentity(agentId);
    if (directPlan?.intent === 'clarify') return this.clarify(directPlan.reply);
    if (agentId === 'creator') return this.createProposal({ text, sourceEventRef, chatRef:source.chatRef });
    if (agentId === 'reviewer') return this.clarify('我是审核官。请发需要审核的任务号或新员工草案编号，并说明你希望我核对的范围。');
    if (agentId === 'technical-expert') {
      const taskId = text.match(TASK_ID_RE)?.[0];
      return taskId
        ? this.technicalTriage(taskId)
        : this.clarify('我是技术专家。请发故障任务号和现象；我会先限定排查范围，不会直接改动生产环境。');
    }
    const directTaskTypes = {
      operator:'operations.health-review',
      architect:'governance.architecture-review',
      xiaod:'media.transcribe-and-refine',
      'intel-researcher':'research.intel-report',
      'office-assistant':/(?:pptx?|幻灯片|演示文稿)/i.test(text) ? 'office.presentation-package' : 'office.briefing-package'
    };
    const taskType = directPlan?.intent === 'route_task' && directPlan.agentId === agentId ? directPlan.taskType : directTaskTypes[agentId];
    if (!taskType) return null;
    const task = await this.tasks.create({
      title:text,
      description:['office.briefing-package', 'office.presentation-package', 'office.knowledge-summary'].includes(taskType) ? text : '',
      taskType,
      requester,
      source,
      agentId,
      ...(taskType === 'research.intel-report' ? { topic:text } : {}),
      idempotencyKey:`feishu:${sourceEventRef}`
    });
    return replyFor(task, taskType);
  }

  async reviewRegisteredDrafts(text) {
    if (typeof this.proposals?.reviewRegisteredDrafts !== 'function') return this.clarify('请发需要审核的任务号或新员工草案编号，并说明你希望我核对的范围。');
    const proposals = await this.proposals.reviewRegisteredDrafts(text);
    if (!proposals.length) return this.clarify('没有找到你点名的草案岗位。请直接说岗位名称，例如“小R”。');
    return {
      kind:'registered_draft_review', proposals,
      reply:proposals.map((proposal) => registeredDraftReviewReply(proposal)).join('\n\n')
    };
  }

  async technicalTriage(taskId) {
    const tasks = typeof this.store?.list === 'function' ? await this.store.list() : [];
    const root = tasks.find((task) => task.taskId === taskId);
    if (!root) return this.clarify(`没有找到任务 ${taskId}。请核对任务号；本轮没有修改系统。`);
    const related = tasks.filter((task) => task.parentTaskId === taskId || task.recovery?.rootTaskId === taskId);
    const recovered = related
      .filter((task) => task.status === 'succeeded' && task.recovery?.rootTaskId === taskId)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    const failure = root.error;
    const evidence = failure
      ? `${failure.code || 'unknown_failure'}；阶段 ${failure.stage || root.currentStage || 'unknown'}；${failure.retryable === true ? '可安全重试' : '未标记为可重试'}`
      : `未记录失败错误；当前阶段 ${root.currentStage || 'unknown'}`;
    const recovery = recovered
      ? `运维官安排的自动重试任务 ${recovered.taskId} 已完成`
      : root.recovery?.coordination?.status
        ? `恢复协调状态：${root.recovery.coordination.status}`
        : '尚无恢复任务记录';
    return {
      kind:'technical_triage',
      task:root,
      relatedTasks:related,
      reply:[
        '【技术专家只读判断】',
        `任务：${root.input?.title || taskId}`,
        `状态：原任务${taskStatusLabel(root.status)}`,
        `故障证据：${evidence}`,
        `恢复链：${recovery}`,
        '范围：本轮只读取任务记录，没有修改系统、没有扩权、没有外发。'
      ].join('\n')
    };
  }

  async directAgentIntent(agentId, text) {
    if (typeof this.planner?.decide !== 'function') return null;
    try { return await this.planner.decide(text, { agentId }); }
    catch { return null; }
  }

  async handlePlannedIntent(plan, { text, sourceEventRef, source, requester, targetAgentId = null }) {
    const intent = plan.intent;
    // Keep normal Chinese on the AI path, but do not let an identity-shaped
    // misclassification replace the factual capability menu the user asked for.
    if (CAPABILITIES_RE.test(text)) return this.armyCapabilities(source.chatRef);
    if (intent === 'identity') return this.identity();
    if (intent === 'clarify') {
      if (plan.awaitingLinkFor) await this.rememberPendingLink(source.chatRef, plan.awaitingLinkFor);
      return this.clarify(plan.reply);
    }
    if (intent === 'agent_proposal') return this.createProposal({ text, sourceEventRef, chatRef: source.chatRef });
    if (['cross_agent_mission', 'army_planning'].includes(intent) && this.missions) return this.missions.create({ title:text, requester, source, idempotencyKey:`feishu:${sourceEventRef}` });
    if (intent === 'army_overview') return this.armyOverview();
    if (intent === 'army_capabilities') return this.armyCapabilities(source.chatRef);
    if (intent === 'army_report') return this.armyReport();
    if (intent === 'usage_report') return this.armyUsage(source.chatRef);
    if (intent === 'task_progress') return this.taskProgress(source.chatRef);
    if (intent === 'employee_status') return this.employeeStatus(plan.agentId);
    if (PAUSE_RE.test(text)) return this.requestTaskControl(source.chatRef, 'pause');
    if (RESUME_RE.test(text)) {
      const resumed = await this.requestTaskControl(source.chatRef, 'resume', { returnNothingWhenMissing:true });
      if (resumed) return resumed;
    }
    const feedback = feedbackSentiment(text);
    if (feedback) return this.recordFeedback(source.chatRef, text, feedback);
    if (FOLLOW_UP_RE.test(text)) return this.followUp(source.chatRef);
    const taskType = plan.taskType || (intent === 'health_check' ? 'operations.health-review' : intent === 'media_task' ? 'media.transcribe-and-refine' : intent === 'public_report' ? 'report.public-material' : intent === 'github_search' ? 'research.github-search' : intent === 'intel_research' ? 'research.intel-report' : intent === 'office_presentation' ? 'office.presentation-package' : intent === 'office_briefing' ? 'office.briefing-package' : ['architecture_review', 'army_planning'].includes(intent) ? 'governance.architecture-review' : 'army.intake');
    const entryAgentId = await this.resolveEntryAgent(targetAgentId, taskType);
    const defaultAgentId = ['report.public-material', 'research.github-search', 'research.intel-report'].includes(taskType)
      ? 'intel-researcher'
      : ['office.briefing-package', 'office.presentation-package', 'office.knowledge-summary'].includes(taskType)
        ? 'office-assistant'
        : ['content.video-benchmark-analysis', 'content.performance-review'].includes(taskType)
          ? 'video-content-analyst'
          : ['content.platform-draft', 'content.video-script-package'].includes(taskType)
            ? 'content-creator'
            : undefined;
    const researchInput = taskType === 'research.github-search' ? githubTaskInput(text) : taskType === 'research.intel-report' ? { topic:text } : {};
    const analysisUrl = taskType === 'content.video-benchmark-analysis' ? publicUrl(text) : null;
    if (analysisUrl && typeof this.missions?.createBusinessMission === 'function') {
      const analysis = resolveAnalysisIntent({ title:text });
      if (analysis.error) return this.clarify('检测到多个分析模式，请只选精华提炼、深度拆解、模板学习或风格探索中的一种。');
      return this.missions.createBusinessMission({
        title:`${text}｜受控获取与分析`,
        requester,
        source,
        idempotencyKey:`feishu:${sourceEventRef}`,
        items:[
          {
            key:'acquire-transcript', title:`获取并整理：${text}`, taskType:'media.transcribe-and-refine', agentId:'xiaod',
            description:'通过内容获取中心处理公开或已授权素材；复用已有字幕，必要时才转录。',
            acceptance:'生成来源证据、质量报告和系统或人工确认稿。', sourceUrls:[analysisUrl],
            reviewPolicy:'optional', evidenceMode:'formal', analysisIntent:analysis.analysisIntent, depth:analysis.depth, visualMode:'auto'
          },
          {
            key:'analyze-video', title:text, taskType:'content.video-benchmark-analysis', agentId:'video-content-analyst',
            description:'只在确认稿存在后生成对应模式的证据化分析。',
            acceptance:'所有关键内容绑定字幕片段、时间点或画面证据。', sourceUrls:[analysisUrl],
            reviewPolicy:'optional', evidenceMode:'formal', analysisIntent:analysis.analysisIntent, depth:analysis.depth, visualMode:'auto',
            dependsOnPrevious:true, dependsOn:['acquire-transcript']
          }
        ]
      });
    }
    const task = await this.tasks.create({
      title: text, description:['office.briefing-package', 'office.presentation-package'].includes(taskType) ? text : '', taskType, requester, source,
      agentId: entryAgentId || plan.agentId || defaultAgentId, ...researchInput, idempotencyKey: `feishu:${sourceEventRef}`
    });
    const intake = task.artifactRefs?.find((item) => item.type === 'task_intake_record')?.data;
    if (taskType === 'army.intake' && intake?.autoContinue === true && typeof this.tasks.continueFromRecommendation === 'function') {
      const followUp = await this.tasks.continueFromRecommendation(task.taskId);
      const followUpResult = replyFor(followUp, followUp.taskType);
      return { ...followUpResult, parentTask:task, reply:`我已经把这件事交给架构师先评估怎么补齐能力。${followUpResult.reply}` };
    }
    const result = replyFor(task, taskType);
    const approval = task.status === 'waiting_approval' ? await this.approvalFor(task) : null;
    const withWatch = this.completionWatchFor(result);
    return approval ? { ...withWatch, approval } : withWatch;
  }

  async createProposal({ text, sourceEventRef, chatRef }) {
    const proposal = await this.proposals.create({ requestedOutcome: text, sourceEventRef, sourceChatRef: chatRef }, { source: 'feishu' });
    const submitted = proposal.status === 'draft' ? await this.proposals.submit(proposal.proposalId) : proposal;
    const reviewer = submitted.reviewRefs?.find((item) => item.role === 'reviewer');
    const approval = submitted.status === 'pending_approval' && submitted.governance?.paperclipApprovalId
      ? {
        approvalId: submitted.proposalId, governanceMode: 'proposal', action: 'agent-proposal-review', riskLevel: 'high',
        reason: `${reviewer?.summary || '这是新岗位草案。'}${submitted.trialReadiness?.message ? ` ${submitted.trialReadiness.message}` : ''}`,
        trialReadyForTest: submitted.trialReadiness?.status === 'ready',
        requestedScope: { title: submitted.candidateManifest.name }, validUntil: null
      }
      : null;
    return {
      kind: 'agent_proposal', proposal,
      reply: submitted.status === 'pending_approval'
        ? `审核官已完成范围检查。已生成 Agent 草案「${submitted.proposalId}」并提交组织级审核；${submitted.trialReadiness?.message || '通过受限测试前不会上线。'}`
        : `已找到 Agent 草案「${submitted.proposalId}」，当前状态：${submitted.status}。`,
      ...(approval ? { approval } : {})
    };
  }

  identity() {
    return {
      kind:'identity',
      reply:[
        '【我是 A君·军团总管】',
        '我负责听懂你想要的结果，安排合适的员工去做，盯住进度、卡点和结果，再回到这条聊天告诉你。',
        '',
        '我自己不假装什么都会：',
        '- 能直接做的，交给已经上岗的员工；',
        '- 当前没人能做的，先自己评估怎么补；',
        '- 涉及登录、外发、花钱或公开发布的事，会先让你确认。',
        '',
        '你不用记指令，直接说你想得到什么就行。'
      ].join('\n')
    };
  }

  clarify(reply = '') {
    return {
      kind:'clarify',
      reply:String(reply || '我还没听清你希望我做什么。直接说你想拿到什么结果、给谁用，或者发链接/材料给我；能直接办的我会安排，不能直接办的我会先说明缺什么。').trim()
    };
  }

  async approvalFor(task) {
    const approvalId = task.approvalRefs?.[0];
    if (!approvalId || !this.store) return null;
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId && item.status === 'pending');
    if (!approval) return null;
    return {
      approvalId: approval.approvalId, governanceMode: approval.governanceMode,
      action: approval.action, riskLevel: approval.riskLevel, reason: approval.reason,
      requestedScope: approval.requestedScope, validUntil: approval.validUntil
    };
  }

  async resolveEntryAgent(entryAgentId, taskType) {
    if (!entryAgentId) return null;
    // A君 owns the conversation but is not a task executor. A direct message
    // to its new smart-agent app must still be routed to the actual worker.
    if (entryAgentId === 'ajun') return null;
    if (entryAgentId !== 'public-reporter') return entryAgentId;
    // A passed trial proposal gets a generated internal id. The public Feishu
    // entry stays stable and is resolved to the one active public-report role.
    const overview = await this.tasks?.overview?.();
    const candidates = (overview?.agents || []).filter((agent) => agent.status === 'active' && agent.acceptedTaskTypes?.includes('report.public-material'));
    return taskType === 'report.public-material' && candidates.length === 1 ? candidates[0].agentId : entryAgentId;
  }

  async taskProgress(chatRef, { taskId = null, agentId = null } = {}) {
    if (!this.store || !chatRef) return { kind: 'task_progress', reply: '我暂时找不到这条会话里的任务。请直接回复那条任务消息后再问“进度”。' };
    const tasks = await this.store.list();
    const inThisChat = tasks.filter((task) => task.source?.channel === 'feishu' && task.source?.chatRef === chatRef);
    const task = taskId
      ? inThisChat.find((item) => item.taskId === taskId) || null
      : mostRecentTask(agentId ? inThisChat.filter((item) => isTaskForAgent(item, agentId)) : inThisChat);
    if (taskId && !task) return { kind:'task_progress', reply:'这个任务号不属于当前飞书会话，或本机已经没有它的记录。' };
    if (agentId && !task) return { kind:'task_progress', reply:`当前会话里没有可核对的${agentDisplayName(agentId)}任务。` };
    if (!task) return { kind: 'task_progress', reply: '当前会话还没有正在处理的任务。' };
    if (typeof this.tasks?.notificationStatus === 'function') {
      const status = await this.tasks.notificationStatus(task.taskId, chatRef);
      return { kind: 'task_progress', task, status, reply: progressHeading(task, agentId, status.message) };
    }
    return { kind: 'task_progress', task, reply: progressHeading(task, agentId, progressReply(task)) };
  }

  async retryXiaodTask(chatRef) {
    if (!this.store || !chatRef) return { kind:'xiaod_retry', reply:'我暂时找不到当前会话里的小D任务。请回复原任务消息后再试。' };
    const tasks = await this.store.list();
    const task = mostRecentTask(tasks.filter((item) => item.source?.channel === 'feishu' && item.source?.chatRef === chatRef && item.taskType === 'media.transcribe-and-refine'));
    if (!task) return { kind:'xiaod_retry', reply:'当前会话没有可继续的小D任务。请发送需要整理的公开视频链接。' };
    if (typeof this.tasks?.notificationStatus === 'function') {
      const status = await this.tasks.notificationStatus(task.taskId, chatRef);
      return { kind:'xiaod_retry', task, status, reply:status.message };
    }
    return { kind:'xiaod_retry', task, reply:progressReply(task) };
  }

  async continueXiaodDelivery(chatRef) {
    if (!this.store || !chatRef) return { kind:'xiaod_delivery', reply:'我暂时找不到当前会话里的小D任务。请回复原任务消息后再试。' };
    const tasks = await this.store.list();
    const task = mostRecentTask(tasks.filter((item) => item.source?.channel === 'feishu' && item.source?.chatRef === chatRef && item.taskType === 'media.transcribe-and-refine'));
    if (!task) return { kind:'xiaod_delivery', reply:'当前会话没有可继续交付的小D任务。' };
    if (typeof this.tasks?.continueXiaodDelivery !== 'function') return { kind:'xiaod_delivery', task, reply:'小D飞书交付恢复入口当前不可用；没有启动外部动作。' };
    try {
      const updated = await this.tasks.continueXiaodDelivery(task.taskId, { chatRef });
      return this.completionWatchFor({
        kind:'xiaod_delivery',
        task:updated,
        reply:`已登记继续飞书交付“${shortTitle(updated)}”。本地确认稿不会重新生成；交付结果会继续回到当前会话。\n任务号：${updated.taskId}。`
      });
    } catch (error) {
      return { kind:'xiaod_delivery', task, reply:String(error?.message || '飞书交付暂时无法继续；没有启动外部动作。') };
    }
  }

  async explicitEmployeeStatus(text) {
    if (!this.tasks?.overview || !isEmployeeStatusQuestion(text)) return null;
    const overview = await this.tasks.overview();
    const employees = (overview.agents || [])
      .filter((agent) => agent.status === 'active' && isVisibleEmployee(agent))
      .map((agent) => ({ agentId:agent.agentId, name:agent.name || agent.agentId }));
    const agentId = namedEmployeeStatusTarget(text, employees);
    return agentId ? this.employeeStatus(agentId, overview) : null;
  }

  async employeeStatus(agentId, knownOverview = null) {
    if (!this.tasks?.overview || !agentId) return this.clarify('你想看哪一位员工最近的工作？');
    const overview = knownOverview || await this.tasks.overview();
    const employee = (overview.agents || []).find((agent) => agent.agentId === agentId);
    if (!employee) return this.clarify('我暂时找不到你说的这位员工。你可以直接说它的名字。');
    const recent = uniqueTasks((overview.tasks || [])
      .filter((task) => isTaskForAgent(task, employee.agentId))
      .sort((left, right) => taskTime(right) - taskTime(left)))
      .slice(0, 3);
    const active = recent.filter((task) => ['queued', 'running', 'pausing', 'paused'].includes(task.status));
    const lines = recent.length
      ? recent.map((task) => `- ${taskStatusLine(task)}`)
      : ['- 目前没有可核对的工作记录。'];
    return {
      kind:'employee_status',
      employee,
      reply:[
        `【${employee.name || employee.agentId}最近情况】`,
        active.length ? `现在有 ${active.length} 项正在处理或等待处理。` : '现在没有正在处理的工作。',
        '',
        '【最近工作】',
        ...lines
      ].join('\n')
    };
  }

  async followUp(chatRef) {
    if (!this.store || !chatRef) return { kind: 'follow_up', reply: '我暂时找不到当前聊天里的工作，不能假装已经继续处理。' };
    const tasks = await this.store.list();
    const task = mostRelevantTask(tasks.filter((item) => item.source?.channel === 'feishu' && item.source?.chatRef === chatRef && ['failed', 'needs_input', 'waiting_test'].includes(item.status)));
    if (!task) return { kind: 'follow_up', task: null, reply: '当前聊天没有需要继续处理的工作。' };
    if (typeof this.tasks?.notificationStatus === 'function') {
      const status = await this.tasks.notificationStatus(task.taskId, chatRef);
      return { kind: 'follow_up', task, status, reply: status.message };
    }
    return { kind: 'follow_up', task, reply: progressReply(task) };
  }

  async recordFeedback(chatRef, text, sentiment) {
    if (!this.store || !chatRef || typeof this.tasks?.recordFeedback !== 'function') {
      return { kind:'task_feedback', reply:'我暂时找不到这条会话里刚完成的工作，暂时没法记录评价。' };
    }
    const tasks = await this.store.list();
    const task = [...tasks]
      .filter((item) => item.source?.channel === 'feishu' && item.source?.chatRef === chatRef && !item.parentTaskId && ['succeeded', 'failed', 'waiting_test', 'cancelled'].includes(item.status))
      .sort((left, right) => taskTime(right) - taskTime(left))[0] || null;
    if (!task) return { kind:'task_feedback', reply:'这条会话里暂时没有刚完成的工作可以评价，我没有新建任何任务。' };
    const updated = await this.tasks.recordFeedback(task.taskId, { sentiment, note:text });
    if (sentiment === 'useful') {
      return { kind:'task_feedback', task:updated, reply:`已记下：你觉得“${shortTitle(task)}”这次结果有用。以后遇到类似工作，我会保留这次有效的做法。` };
    }
    return { kind:'task_feedback', task:updated, reply:`已记下：“${shortTitle(task)}”这次结果需要改进。我不会假装已经重做；后续复盘会优先检查这类问题。你想改哪里时，直接说一句就行。` };
  }

  async approveLatestVideoScript({ sourceEventRef, source, requester }) {
    const tasks = typeof this.store?.list === 'function' ? await this.store.list() : [];
    const latest = tasks
      .filter((item) => item.source?.chatRef === source.chatRef && item.taskType === 'content.video-script-package' && item.status === 'succeeded')
      .sort((left, right) => taskTime(right) - taskTime(left))
      .find((item) => item.artifactRefs?.some((artifact) => artifact.type === 'video_script_package' && artifact.data?.templateLifecycle?.approvedForUse !== true));
    if (!latest) return { kind:'content_script', reply:'当前会话里没有可采用的脚本，请先告诉我想做什么主题。' };
    const task = await this.tasks.create({
      title:`采用脚本：${latest.input?.title || '当前版本'}`,
      taskType:'content.video-script-package',
      requester,
      source,
      agentId:'content-creator',
      contentGoal:latest.input?.contentGoal || latest.input?.title,
      approvedForUse:true,
      sourceScriptTaskId:latest.taskId,
      context:{ sourceTaskIds:[latest.taskId] },
      idempotencyKey:`feishu:${sourceEventRef}`
    });
    return replyFor(task, task.taskType);
  }

  async reviseLatestVideoScript({ text, sourceEventRef, source, requester }) {
    const tasks = typeof this.store?.list === 'function' ? await this.store.list() : [];
    const latest = tasks
      .filter((item) => item.source?.chatRef === source.chatRef && item.taskType === 'content.video-script-package' && item.status === 'succeeded')
      .sort((left, right) => taskTime(right) - taskTime(left))[0];
    if (!latest) return null;
    const originalGoal = latest.input?.contentGoal || latest.input?.title || '当前视频主题';
    const task = await this.tasks.create({
      title:`修改脚本：${text}`,
      taskType:'content.video-script-package',
      requester,
      source,
      agentId:'content-creator',
      contentGoal:`${originalGoal}。本次修改要求：${text}`,
      sourceScriptTaskId:latest.taskId,
      context:{ sourceTaskIds:[latest.taskId] },
      idempotencyKey:`feishu:${sourceEventRef}`
    });
    return replyFor(task, task.taskType);
  }

  async requestTaskControl(chatRef, action, { returnNothingWhenMissing = false } = {}) {
    if (!this.store || !chatRef) return { kind:'task_control', reply:'我暂时找不到当前会话里的任务，不能直接暂停或继续。' };
    const tasks = (await this.store.list()).filter((task) => task.source?.channel === 'feishu' && task.source?.chatRef === chatRef);
    const task = mostRelevantTask(tasks.filter((item) => action === 'pause' ? ['queued', 'running', 'pausing'].includes(item.status) : item.status === 'paused'));
    if (!task) {
      if (action === 'resume') {
        const latestXiaod = mostRelevantTask(tasks.filter((item) => item.taskType === 'media.transcribe-and-refine' && item.execution?.executor === 'xiaod'));
        if (latestXiaod?.status === 'succeeded') {
          return { kind:'task_control', task:latestXiaod, reply:`“${shortTitle(latestXiaod)}”已经完成，不能继续；我没有新建任务或交给其他员工。` };
        }
        if (latestXiaod?.status === 'cancelled') {
          return { kind:'task_control', task:latestXiaod, reply:`“${shortTitle(latestXiaod)}”已经关闭，不能继续；我没有新建任务或交给其他员工。` };
        }
      }
      if (returnNothingWhenMissing) return null;
      return { kind:'task_control', reply:action === 'pause' ? '当前会话没有可以暂停的工作。' : '当前会话没有已暂停、可以继续的工作。' };
    }
    const result = action === 'pause' ? await this.tasks.requestPause(task.taskId) : await this.tasks.requestResume(task.taskId);
    const approval = result.approval;
    const verb = action === 'pause' ? '暂停' : '继续';
    return {
      kind:'task_control', task:result.task,
      reply:approval ? `我已提交“${shortTitle(task)}”的${verb}确认。你同意前，任务不会改变当前状态。` : `“${shortTitle(task)}”的${verb}确认已在等待处理。`,
      ...(approval ? { approval:{ approvalId:approval.approvalId, governanceMode:approval.governanceMode, action:approval.action, riskLevel:approval.riskLevel, reason:approval.reason, requestedScope:approval.requestedScope, validUntil:approval.validUntil } } : {})
    };
  }

  async armyOverview() {
    if (!this.tasks?.overview) return { kind: 'army_overview', reply: '我暂时无法读取军团状态，请稍后再问。' };
    const overview = await this.tasks.overview();
    const agents = overview.agents || [];
    const tasks = overview.tasks || [];
    const names = Object.fromEntries(agents.map((agent) => [agent.agentId, agent.name || agent.agentId]));
    const activeTasks = uniqueTasks(tasks.filter((task) => !['succeeded', 'cancelled'].includes(task.status)));
    const frontLineAgents = agents.filter(isVisibleEmployee);
    const supportAgents = agents.filter((agent) => !isVisibleEmployee(agent));
    const needOwner = activeTasks.filter((task) => ['waiting_approval', 'needs_input'].includes(task.status));
    const ajunStatus = activeTasks.length ? `正在跟进 ${activeTasks.length} 项没有结束的工作` : '当前没有需要继续跟进的工作';
    const workerLines = frontLineAgents.length
      ? frontLineAgents.map((agent) => `- ${names[agent.agentId]}：${employeeRole(agent)}；${employeeWorkState(agent, activeTasks)}`)
      : ['- 目前还没有能直接交付工作的员工。'];
    const supportLines = supportAgents.length
      ? supportAgents.map((agent) => `- ${names[agent.agentId]}：${employeeRole(agent)}；${employeeWorkState(agent, activeTasks)}`)
      : [];
    const ownerLines = needOwner.length
      ? needOwner.map((task) => `- “${shortTitle(task)}”`)
      : ['- 现在没有必须由你决定的事情。'];
    return {
      kind: 'army_overview',
      reply: [
        '【军团情况】',
        `共 ${agents.length + 1} 位：${agents.length} 位员工 + 我（A君）。`,
        `我：${ajunStatus}。`,
        '',
        '【直接干活的员工】',
        ...workerLines,
        ...(supportLines.length ? ['', '【后台支持】', ...supportLines] : []),
        '',
        '【现在需要你决定的事】',
        ...ownerLines
      ].join('\n')
    };
  }

  async armyCapabilities(chatRef = '') {
    if (!this.tasks?.overview) return { kind:'army_capabilities', reply:'我暂时无法读取军团能力清单，请稍后再问。' };
    const overview = await this.tasks.overview();
    const activeTaskTypes = new Set((overview.agents || [])
      .filter((agent) => agent.status === 'active')
      .flatMap((agent) => agent.acceptedTaskTypes || []));
    const abilities = [
      '查看现在有多少员工、分别在做什么、谁卡住了、今天做了什么和需要你决定的事',
      activeTaskTypes.has('operations.health-review') ? '检查本机军团是否正常，异常会如实说出来' : null,
      activeTaskTypes.has('media.transcribe-and-refine') ? '整理公开视频或音频，完成后把结果发回原聊天' : null,
      activeTaskTypes.has('report.public-material') ? '读一到五条公开网页，做中文重点、共同点和差别对比' : null,
      activeTaskTypes.has('research.github-search') ? '让小R在公开 GitHub 找开源项目，比较 star、语言、最近更新时间和适用场景' : null,
      activeTaskTypes.has('research.intel-report') ? '让小R围绕一个主题综合公开来源，给出结论、行动建议和来源' : null,
      activeTaskTypes.has('governance.architecture-review') ? '遇到当前没人能直接完成的低风险事情，先自己请架构师评估怎么补能力' : null,
      '创建新员工草案；必须先审核和小范围试用，不会直接上线'
    ].filter(Boolean);
    await this.rememberCapabilitiesContext(chatRef, abilities);
    return {
      kind:'army_capabilities',
      reply: [
        '【我现在能直接帮你办的事】',
        ...abilities.map((item, index) => `${index + 1}. ${item}`),
        '',
        '你只要直接说想要的结果。当前没有合适员工时，我会先评估怎么补，不会让你背固定说法。'
      ].join('\n')
    };
  }

  async armyReport() {
    if (!this.tasks?.overview) return { kind: 'army_report', reply: '我暂时无法整理今天的军团工作汇报，请稍后再问。' };
    const overview = await this.tasks.overview();
    const tasks = overview.tasks || [];
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const todayTasks = tasks.filter(isToday);
    const completed = uniqueTasks(todayTasks.filter((task) => task.status === 'succeeded' && shouldShowInReport(task, byId)));
    const active = uniqueTasks(todayTasks.filter((task) => ['queued', 'running'].includes(task.status) && shouldShowInReport(task, byId)));
    const ownerBlocked = uniqueTasks(todayTasks.filter((task) => ['waiting_approval', 'needs_input'].includes(task.status)));
    const failed = uniqueTasks(todayTasks.filter((task) => task.status === 'failed' && shouldShowInReport(task, byId)));
    const waitingTests = todayTasks.filter((task) => task.status === 'waiting_test');
    const doneText = completed.length ? `今天已完成 ${completed.length} 项：${taskList(completed)}。` : '今天目前还没有新的完成结果。';
    const activeText = active.length ? `正在推进 ${active.length} 项：${taskList(active)}。` : '现在没有正在推进的新工作。';
    const concerns = [...ownerBlocked.map(taskStatusLine), ...failed.map(taskStatusLine)];
    if (waitingTests.length) concerns.push(`另有 ${waitingTests.length} 项技术检查仍待测试，已记录，不影响其他工作`);
    const blockedText = concerns.length ? concerns.map((item) => `- ${item}`) : ['- 当前没有新卡住的工作。'];
    const ownerText = ownerBlocked.length ? ownerBlocked.map((task) => `- ${taskStatusLine(task)}`) : ['- 现在没有必须由你决定的事情。'];
    return {
      kind:'army_report',
      reply: [
        '【今天的军团工作汇报】',
        '',
        '【已完成】', doneText,
        '',
        '【正在做】', activeText,
        '',
        '【需要留意】', ...blockedText,
        '',
        '【需要你决定】', ...ownerText
      ].join('\n')
    };
  }

  async armyUsage(chatRef = '') {
    if (typeof this.tasks?.usageOverview !== 'function') return { kind:'usage_report', reply:'我暂时无法汇总今天的实际使用情况，请稍后再问。' };
    const usage = await this.tasks.usageOverview();
    const usageTasks = await this.todayUsageTasks();
    await this.rememberUsageContext(chatRef, usage, usageTasks);
    const workText = usage.trackedTaskCount ? `今天有 ${usage.trackedTaskCount} 项本机执行记录（包含业务工作、系统检查和测试/修复，不等于 ${usage.trackedTaskCount} 件已交付结果），共发生 ${usage.actualToolCalls} 次本机处理。` : '今天还没有留下可核对的实际执行记录。';
    const costText = usage.cost.reportedTaskCount
      ? `已收到 ${usage.cost.reportedTaskCount} 项费用数据：${usage.cost.totals.map((item) => `${item.amount} ${item.currency}`).join('，')}。`
      : '执行方暂时没有返回可核对的费用数据，我不会猜金额。';
    return { kind:'usage_report', usage, reply:`${workText}${costText}` };
  }

  async contextualUnderstanding(text, chatRef) {
    if (!this.store?.getConversationContext || !chatRef) return null;
    const context = await this.store.getConversationContext(chatRef);
    if (!isCurrentConversationContext(context)) return null;
    const menuIntent = capabilityMenuIntent(text, context);
    if (menuIntent === 'agent_proposal_prompt') return { reply:{ kind:'agent_proposal_prompt', reply:'你想新增哪一类员工？直接说“希望它负责什么、最后交给你什么结果、哪些事不能做”。我会先生成草案给你审核，不会直接上线。' } };
    if (menuIntent) return { plan:{ intent:menuIntent } };
    // A rich-link card can arrive as only its title. It must never be treated
    // as a vague follow-up to an earlier usage report just because AI guesses
    // so. Usage detail is only allowed for an explicit short follow-up.
    if (!shouldShowRecentUsageItems(text, context)) return null;
    let decision = null;
    try { decision = await this.conversationAdvisor?.decide({ message:text, context }); }
    catch { /* AI 临时不可用时，仍用最近的已保存事实接住明显追问。 */ }
    if (decision?.action === 'show_last_usage_items' || shouldShowRecentUsageItems(text, context)) {
      return { reply:await this.lastUsageItems(context) };
    }
    return null;
  }

  async rememberUsageContext(chatRef, usage, tasks) {
    if (!this.store?.setConversationContext || !chatRef) return;
    const now = new Date();
    const taskIds = tasks.map((task) => task.taskId).filter(Boolean).slice(0, 40);
    await this.store.setConversationContext(chatRef, {
      kind:'usage_report', createdAt:now.toISOString(), expiresAt:new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      recordedTaskCount:Number(usage?.trackedTaskCount || 0), actualToolCalls:Number(usage?.actualToolCalls || 0), taskIds
    });
  }

  async rememberCapabilitiesContext(chatRef, abilities) {
    if (!this.store?.setConversationContext || !chatRef) return;
    const now = new Date();
    await this.store.setConversationContext(chatRef, {
      kind:'capabilities_menu', createdAt:now.toISOString(), expiresAt:new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      optionCount:abilities.length
    });
  }

  async rememberPendingLink(chatRef, pending) {
    if (!this.store?.setConversationContext || !chatRef || !pending?.taskType) return;
    const now = new Date();
    await this.store.setConversationContext(chatRef, {
      kind:'awaiting_link', createdAt:now.toISOString(), expiresAt:new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      taskType:String(pending.taskType), agentId:safeAgentId(pending.agentId)
    });
  }

  async handlePendingLink(text, { sourceEventRef, source, requester, targetAgentId }) {
    if (!publicUrl(text) || !this.store?.getConversationContext || !source.chatRef) return null;
    const context = await this.store.getConversationContext(source.chatRef);
    if (!isCurrentPendingLinkContext(context)) return null;
    return this.handlePlannedIntent(
      { intent:'route_task', taskType:context.taskType, agentId:safeAgentId(context.agentId) || undefined },
      { text, sourceEventRef, source, requester, targetAgentId }
    );
  }

  async todayUsageTasks() {
    if (!this.store?.list) return [];
    const since = startOfToday();
    return (await this.store.list()).filter((task) => task.usage?.schemaVersion === 'agent.army/task-usage/v1' && taskUsageTime(task) >= since);
  }

  async lastUsageItems(context) {
    const allTasks = await this.store.list();
    const taskById = new Map(allTasks.map((task) => [task.taskId, task]));
    const tasks = (context.taskIds || []).map((taskId) => taskById.get(taskId)).filter(Boolean);
    if (!tasks.length) return { kind:'usage_details', reply:'刚才那份使用汇总已经过期，或对应记录不在本机了。我不能编造明细；你可以再问一次“今天花了多少”，我会重新汇总。' };
    const lines = tasks.map((task, index) => {
      const toolCalls = (task.usage?.tools || []).reduce((total, tool) => total + Number(tool.calls || 0), 0);
      return `${index + 1}. “${shortTitle(task)}”\n   - 承接：${workerName(task)}；当前：${taskStatusLabel(task.status)}；本机处理：${toolCalls} 次`;
    });
    return {
      kind:'usage_details',
      reply:[
        `【你刚才问的 ${tasks.length} 项工作记录】`,
        ...lines,
        '',
        '这些是今天留下实际执行记录的工作，不代表都已经交付完成。费用没有被执行方明确返回的，我仍不会猜。'
      ].join('\n')
    };
  }

  async intentFor(text) {
    if (VIDEO_SCRIPT_RE.test(text)) return { intent:'route_task', taskType:'content.video-script-package', agentId:'content-creator' };
    const analysisPlan = videoAnalysisPlan(text);
    if (analysisPlan) return analysisPlan;
    if (typeof this.planner?.decide !== 'function') return directIntent(text);
    try {
      const [routes, employees] = await Promise.all([this.availableRoutes(), this.availableEmployees()]);
      const planned = await this.planner?.decide(text, { routes, employees });
      // “谁在干什么”才是概览；用户要求判断故障、给恢复边界时，必须真正交给运维官。
      // 模型偶尔会把“任务卡住”误归到概览，这里以明确的运维意图兜底。
      if (isOperationsTriageRequest(text) && ['army_overview', 'army_report', 'task_progress'].includes(planned?.intent)) return { intent:'health_check' };
      // “复盘最近工作”是架构师基于真实记录的改进请求，不是日报。
      if (isArchitectureReviewRequest(text) && ['army_overview', 'army_report', 'task_progress'].includes(planned?.intent)) return { intent:'architecture_review' };
      // 用户明确要做竞品研究和行动清单，但当前岗位没有被指定可直接完成时，
      // 先给架构师评估最小能力缺口，不把它降级为要求负责人补固定材料。
      if (isCapabilityGapRequest(text) && ['clarify', 'intake', 'public_report', 'intel_research', 'github_search'].includes(planned?.intent)) return { intent:'architecture_review' };
      if (planned?.intent === 'employee_status' && namedEmployeeStatusTarget(text, employees) !== planned.agentId) {
        return linkClarificationPlan(text);
      }
      if (planned?.intent === 'clarify' && isXiaodLinkRequest(text)) return linkClarificationPlan(text, planned.reply);
      if (planned?.intent === 'usage_report' && !USAGE_RE.test(text)) return { intent:'clarify', reply:'我没看出你是在问今天的使用情况。你想让我怎么处理这条内容？' };
      if (planned?.intent === 'intake' && isGithubRequest(text)) return { intent:'github_search' };
      if (planned?.intent === 'intake' && isIntelResearchRequest(text)) return { intent:'intel_research' };
      if (planned?.intent === 'intake' && isSafePublicResearchRequest(text)) return { intent:'public_report' };
      if (planned?.intent) return planned;
    } catch { /* AI 临时不可用时，继续使用现有安全识别。 */ }
    const direct = directIntent(text);
    if (direct.intent !== 'intake') return direct;
    // AI 偶尔会把“查公开竞品”保守地归成普通待办。这个兜底只接住
    // 目标明确、且没有登录/付费/外发风险的公开资料请求，避免负责人反复补链接。
    if (isGithubRequest(text)) return { intent:'github_search' };
    if (isIntelResearchRequest(text)) return { intent:'intel_research' };
    if (isSafePublicResearchRequest(text)) return { intent:'public_report' };
    // AI 临时不可用时，也不能把一句闲聊、编号或模糊追问登记为一项
    // “泛任务”。只有看上去确实在交代工作时，才交给现有的能力评估流程。
    return looksLikeWorkRequest(text) ? direct : { intent:'clarify' };
  }

  async availableRoutes() {
    if (!this.tasks?.overview) return [];
    const overview = await this.tasks.overview();
    return (overview.agents || []).filter((agent) => agent.status === 'active' && isVisibleEmployee(agent)).flatMap((agent) => (agent.acceptedTaskTypes || []).map((taskType) => ({ taskType, agentId:agent.agentId, name:agent.name || agent.agentId })));
  }

  async availableEmployees() {
    if (!this.tasks?.overview) return [];
    const overview = await this.tasks.overview();
    return (overview.agents || [])
      .filter((agent) => agent.status === 'active' && isVisibleEmployee(agent))
      .map((agent) => ({ agentId:agent.agentId, name:agent.name || agent.agentId }));
  }

  completionWatchFor(result) {
    const taskId = String(result?.task?.taskId || '').trim();
    const status = String(result?.task?.status || '').trim();
    const recoveryStarted = status === 'failed'
      && ['pending', 'retrying', 'escalated'].includes(String(result?.task?.recovery?.coordination?.status || ''));
    if (!taskId || (!['queued', 'running'].includes(status) && !recoveryStarted) || !this.ajunBaseUrl) return result;
    return { ...result, completionWatch: { kind:'ajun_task', taskId, baseUrl:this.ajunBaseUrl } };
  }
}

export class FeishuCommanderValidationError extends Error {}

function conversationControlIntent(text) {
  if (FOLLOW_UP_RE.test(text) || PAUSE_RE.test(text) || RESUME_RE.test(text) || feedbackSentiment(text)) return { intent:'known_command' };
  return null;
}

function directIntent(text) {
  // 这里只是 AI 不可用时的保底，不再作为正常中文的第一道入口。
    if (/(?:你是谁|你是做什么|你.*负责什么|介绍.*你自己|介绍.*自己|你.*什么身份)/i.test(text)) return { intent:'identity' };
    if (CREATE_AGENT_RE.test(text)) return { intent:'agent_proposal' };
    if (/多人|多位|多个员工|大家一起|军团协作|协同.*(?:员工|军团)|组织.*(?:盘点|复盘|协作)/.test(text)) return { intent:'cross_agent_mission' };
    if (PROGRESS_RE.test(text)) return { intent:'task_progress' };
    if (USAGE_RE.test(text)) return { intent:'usage_report' };
    if (/(?:日报|工作汇报|工作总结|今天.*(?:完成了什么|做了什么|干了什么|工作情况)|(?:总结|汇报).*(?:今天|军团|工作))/i.test(text)) return { intent:'army_report' };
    if (isOperationsTriageRequest(text)) return { intent:'health_check' };
    if (/多少.*(?:员工|agent|助手)|谁.*(?:在干|忙|卡住)|(?:员工|军团).*(?:状态|情况|进度)|(?:今天|现在|目前).*(?:需要我|要我).*(?:处理|决定|确认|补充)|(?:有什么|哪些).*(?:需要我|要我).*(?:处理|决定|确认|补充)/i.test(text)) return { intent:'army_overview' };
    if (CAPABILITIES_RE.test(text)) return { intent:'army_capabilities' };
    if (HEALTH_RE.test(text)) return { intent:'health_check' };
    if (VIDEO_SCRIPT_RE.test(text)) return { intent:'route_task', taskType:'content.video-script-package', agentId:'content-creator' };
    const analysisPlan = videoAnalysisPlan(text);
    if (analysisPlan) return analysisPlan;
    if (MEDIA_RE.test(text)) return { intent:'media_task' };
    if (OFFICE_RE.test(text)) return { intent:'office_briefing' };
    if (isGithubRequest(text)) return { intent:'github_search' };
    if (isIntelResearchRequest(text)) return { intent:'intel_research' };
    if (publicUrl(text)) return { intent:'public_report' };
    if (/优先.*(?:做|处理)|怎么推进|安排.*(?:合适|员工|人).*做|最值得.*(?:做|处理)|下一步.*(?:做|处理)/.test(text)) return { intent:'army_planning' };
    if (/重复.*工作|反复.*事情|需要.*新员工|岗位.*缺口|能力.*缺口|架构.*评估|复盘.*工作/.test(text)) return { intent:'architecture_review' };
    return { intent:'intake' };
}

function videoAnalysisPlan(text) {
  if (!VIDEO_ANALYSIS_MODE_RE.test(text) || !(MEDIA_RE.test(text) || publicUrl(text))) return null;
  const analysis = resolveAnalysisIntent({ title:text });
  if (analysis.error === 'analysis_intent_conflict') {
    return { intent:'clarify', reply:'检测到多个分析模式，请只选精华提炼、深度拆解、模板学习或风格探索中的一种。' };
  }
  return { intent:'route_task', taskType:'content.video-benchmark-analysis', agentId:'video-content-analyst' };
}

function isSafePublicResearchRequest(text) {
  const value = String(text || '');
  if (/(?:登录|账号|密码|cookie|付费|购买|下单|外发|发送给|私密|内部资料|绕过)/i.test(value)) return false;
  return /(?:查找|搜索|查一查|研究|对比|了解|收集|整理).{0,80}(?:公开|竞品|产品介绍|产品资料|网页|文章|案例)/i.test(value);
}

function isGithubRequest(text) {
  const value = String(text || '');
  if (/(?:github|git\s*hub|开源项目|开源仓库)/i.test(value)) return true;
  return /(?:^|\s|[“"'`（(])([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)(?=$|\s|[，。,.；;）)"'`])/i.test(value);
}
function isIntelResearchRequest(text) {
  const value = String(text || '');
  if (/(?:登录|账号|密码|cookie|付费|购买|下单|外发|发送给|私密|内部资料|绕过)/i.test(value)) return false;
  return /(?:研究|调研|情报).{0,100}(?:主题|结论|建议|行动|背景|发现|问题)|(?:背景|关键发现|结论|行动建议|未决问题)/i.test(value);
}
function githubTaskInput(text) {
  const value = String(text || '');
  const urlMatch = value.match(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/[^\s]*)?/i);
  const shortMatch = value.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  const repo = urlMatch ? `${urlMatch[1]}/${urlMatch[2]}` : shortMatch?.[1] || '';
  if (!repo) return { query:githubSearchQuery(value) };
  const explicitPath = value.match(/(?:文件|file|路径|path)\s*[：:]?\s*([A-Za-z0-9_./-]+)/i)?.[1];
  return { repo, ...(explicitPath ? { path:explicitPath } : {}) };
}

function githubSearchQuery(value) {
  // GitHub repository search does not reliably match a full Chinese request.
  // Keep the original request as the task title, but pass a precise public
  // repository query to the API for the common governance vocabulary.
  if (/(?:agent|智能体).{0,12}(?:治理|管控|权限)|(?:治理|管控|权限).{0,12}(?:agent|智能体)/i.test(value)) return 'agent governance';
  if (/多智能体|multi[\s-]?agent/i.test(value)) return 'multi-agent';
  return value.trim();
}

function looksLikeWorkRequest(text) {
  return /(?:帮我|请(?:你)?|给我|安排|做一下|做个|做一份|整理|查找|查询|搜索|研究|分析|规划|生成|写(?:一份|个)?|制作|建立|修复|测试|评估|对比|翻译|总结)/i.test(String(text || ''));
}

function isEmployeeStatusQuestion(text) {
  return /(?:最近(?:在)?(?:干|做)(?:了)?(?:啥|什么)|目前(?:在)?(?:干嘛|干什么|做什么|忙什么)|现在(?:在)?(?:干嘛|干什么|做什么|忙什么)|当前(?:在)?(?:干嘛|干什么|做什么|忙什么)|正在(?:干嘛|干什么|做什么|忙什么)|在干(?:嘛|什么)|在做(?:嘛|什么)|忙(?:什么|啥)|(?:工作)?状态|(?:最近|当前|工作)?情况|(?:工作)?进展|卡住)/i.test(String(text || ''));
}

function namedEmployeeStatusTarget(text, employees) {
  const value = compactMention(text);
  const matches = (employees || []).filter((employee) => {
    const names = [employee.name, employee.agentId]
      .map(compactMention)
      .filter((name) => name.length >= 2);
    return names.some((name) => value.includes(name));
  });
  return matches.length === 1 ? matches[0].agentId : null;
}

function compactMention(value) {
  return String(value || '').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
}

function isXiaodLinkRequest(text) {
  return /小\s*d/i.test(String(text || '')) && /(?:链接|网址|url|验证|补充)/i.test(String(text || ''));
}

function linkClarificationPlan(text, reply = '') {
  const needsXiaod = isXiaodLinkRequest(text);
  return {
    intent:'clarify',
    reply: reply || (needsXiaod ? '请提供需要小D补充或验证的具体链接。' : /链接|网址|url/i.test(text) ? '请把需要处理或验证的链接发给我。' : undefined),
    ...(needsXiaod ? { awaitingLinkFor:{ taskType:'media.transcribe-and-refine', agentId:'xiaod' } } : {})
  };
}

function formatVideoScriptReply(report) {
  if (report.templateLifecycle?.approvedForUse === true) {
    return '已采用这版。可拍脚本和制作包已经准备好；没有生成成片，也没有发布。';
  }
  const notes = Array.isArray(report.shootingNotes)
    ? report.shootingNotes.slice(0, 3).map((item) => `- ${item}`).join('\n')
    : '';
  return [
    '【可拍脚本】',
    `标题：${report.headline}`,
    `建议：${report.platform || 'douyin'}｜约 ${report.durationSeconds || 45} 秒`,
    '',
    `开场：${report.hook}`,
    '',
    report.fullScript,
    ...(notes ? ['', '拍摄提示：', notes] : []),
    '',
    '下一步：满意就回复“用这版”；要改直接说一句，例如“更像我说话”或“节奏快一点”。'
  ].join('\n');
}

function replyFor(task, taskType) {
  if (task.status === 'succeeded' && !validateTaskCompletion(task).valid) {
    return {
      kind:'completion_waiting_test',
      task,
      reply:`“${shortTitle(task)}”已经停止运行，但完成产物没有通过对应任务门禁；已转交待测试，不会冒充成功。\n任务号：${task.taskId}。`,
    };
  }
  if (['waiting_test', 'failed', 'cancelled'].includes(task.status)) {
    return { kind:'task_status', task, reply:progressReply(task) };
  }
  if (taskType === 'operations.health-review') {
    const report = task.artifactRefs?.find((item) => item.type === 'health_report')?.data;
    return { kind: 'health_review', task, reply: report ? healthReviewReply(task, report) : `运维官已接手检查，任务号：${task.taskId}。` };
  }
  if (taskType === 'media.transcribe-and-refine') {
    if (!task.input?.sourceUrl) return { kind: 'media_task', task, reply: `已收到素材整理请求。请再发送一条可公开访问的视频或音频链接；未开始处理。任务号：${task.taskId}。` };
    if (task.status === 'needs_input' || task.status === 'waiting_approval') {
      const reason = task.error?.userMessage || task.routing?.reason || '小D还没有接到可执行的任务。';
      return { kind:'media_task', task, reply:`小D尚未开始处理：${reason}\n任务号：${task.taskId}。` };
    }
    if (task.execution?.executor !== 'xiaod' && task.assigneeAgentId !== 'xiaod') {
      return { kind:'media_task', task, reply:`小D尚未开始处理：任务还没有正确路由到小D。\n任务号：${task.taskId}。` };
    }
    return { kind: 'media_task', task, reply: `已交给小D处理公开素材，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'report.public-material') {
    const report = task.artifactRefs?.find((item) => item.type === 'public_web_report')?.data;
    if (report) return { kind: 'public_report', task, reply: formatPublicReportReply(report, { taskTitle:task.input?.title }) };
    if (task.status === 'needs_input') return { kind: 'public_report', task, reply: task.error?.userMessage || '这次公开网页整理还缺少必要信息，暂时没有开始读取。' };
    if (!task.input?.sourceUrl) return { kind: 'public_report', task, reply: `已收到公开网页整理请求。请再发送一条能直接打开的网页链接；未开始读取。任务号：${task.taskId}。` };
    return { kind: 'public_report', task, reply: `已交给公开网页摘要员工处理，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'research.github-search') {
    const artifact = task.artifactRefs?.find((item) => ['research_github_report', 'github_code_read'].includes(item.type))?.data;
    if (artifact) return { kind:'github_search', task, reply:formatGithubReply(artifact) };
    if (task.status === 'needs_input') return { kind:'github_search', task, reply:task.currentStage === 'waiting_for_agent_activation' ? '小R的 GitHub 检索能力尚未启用，不能开始检索。' : task.error?.userMessage || '小R还缺少检索条件，暂未开始。' };
    return { kind:'github_search', task, reply:`已交给小R检索公开 GitHub 信息，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'research.intel-report') {
    const report = task.artifactRefs?.find((item) => item.type === 'intel_research_report')?.data;
    if (report) return { kind:'intel_research', task, reply:formatIntelReply(report) };
    if (task.status === 'needs_input') return { kind:'intel_research', task, reply:task.currentStage === 'waiting_for_agent_activation' ? '小R目前还是草案，尚未通过审核和受限测试，不能开始研究。' : task.error?.userMessage || '小R还缺少研究条件，暂未开始。' };
    return { kind:'intel_research', task, reply:`已交给小R研究，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'office.briefing-package') {
    const report = task.artifactRefs?.find((item) => item.type === 'office_briefing_package')?.data;
    if (report) return { kind:'office_briefing', task, reply:formatOfficeBriefingReply(report) };
    if (task.status === 'needs_input') return { kind:'office_briefing', task, reply:task.error?.userMessage || '办公执行助理还缺少需要整理的材料。' };
    return { kind:'office_briefing', task, reply:`已交给办公执行助理整理，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'office.presentation-package') {
    const source = task.artifactRefs?.find((item) => item.type === 'office_presentation_source');
    const pptx = task.artifactRefs?.find((item) => item.type === 'office_pptx_document');
    if (source?.validation?.structuralQaPassed) {
      return {
        kind:'office_presentation',
        task,
        reply:[
          `小办已生成可编辑 PPTD：${source.location}`,
          pptx?.validation?.visualQaPassed
            ? `PPTX 和图片质检已完成：${pptx.location}`
            : task.error?.userMessage || 'PPTX 和图片质检尚未完成。',
        ].join('\n'),
      };
    }
    if (task.status === 'needs_input') return { kind:'office_presentation', task, reply:task.error?.userMessage || '小办还缺少演示文稿标题或逐页提纲。' };
    return { kind:'office_presentation', task, reply:`已交给小办制作演示文稿，任务号：${task.taskId}。PPTD、PPTX 和视觉质检会分别报告。` };
  }
  if (taskType === 'office.knowledge-summary') {
    const note = task.artifactRefs?.find((item) => item.type === 'knowledge_summary_note');
    if (note?.validation?.readable) return { kind:'knowledge_summary', task, reply:`小办已完成知识归档：${note.title}\n受控文件：${note.location}` };
    if (task.status === 'needs_input') return { kind:'knowledge_summary', task, reply:task.error?.userMessage || '小办还缺少需要归档的任务或材料。' };
    return { kind:'knowledge_summary', task, reply:`已交给小办总结并归档，任务号：${task.taskId}。` };
  }
  if (taskType === 'content.video-benchmark-analysis' || taskType === 'content.performance-review') {
    if (task.status === 'needs_input') return { kind:'content_analysis', task, reply:task.error?.userMessage || '小拆还缺少确认稿或表现数据。' };
    return { kind:'content_analysis', task, reply:`已交给小拆处理，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'content.platform-draft') {
    if (task.status === 'needs_input') return { kind:'content_draft', task, reply:task.error?.userMessage || '小创还缺少确认稿、正式分析或目标平台。' };
    return { kind:'content_draft', task, reply:`已交给小创生成可审核草稿，任务号：${task.taskId}。不会自动发布。` };
  }
  if (taskType === 'content.video-script-package') {
    const script = task.artifactRefs?.find((item) => item.type === 'video_script_package')?.data;
    if (script?.fullScript) return { kind:'content_script', task, reply:formatVideoScriptReply(script) };
    if (task.status === 'needs_input') return { kind:'content_script', task, reply:task.error?.userMessage || '小创还缺少视频主题。' };
    return { kind:'content_script', task, reply:'已交给小创生成一版可拍脚本。完成后会回到当前飞书会话。' };
  }
  if (taskType === 'governance.architecture-review') {
    const report = task.artifactRefs?.find((item) => item.type === 'architecture_review')?.data;
    const patterns = report?.workEvidence?.frequentPatterns || [];
    const opportunities = report?.roleOpportunities || [];
    const nextAction = report?.nextAction || '这些建议不会自动上线；先用一条真实验收任务确认后再继续。';
    const understood = report?.understoodRequest;
    if (understood?.outcome && understood?.deliverable) {
      const missing = Array.isArray(understood.missing) && understood.missing.length
        ? understood.missing.slice(0, 4).join('、')
        : '暂时没有确认可供处理的原始材料';
      return {
        kind:'architecture_review',
        task,
        reply:`我已让架构师评估这件具体工作。\n目标：${understood.outcome}\n交付物：${understood.deliverable}\n当前缺少：${missing}\n安全下一步：${nextAction}\n边界：没有创建新员工、登录账号、外发或假装已经完成。`
      };
    }
    if (opportunities.length) return { kind:'architecture_review', task, reply:`我已让架构师复盘真实工作：发现 ${patterns.length} 类重复事项，并形成 ${opportunities.length} 个新岗位草案建议；建议：${nextAction}` };
    return { kind:'architecture_review', task, reply:patterns.length ? `我已让架构师复盘真实工作：发现 ${patterns.length} 类重复事项。建议：${nextAction}` : `我已让架构师复盘真实工作。建议：${nextAction}` };
  }
  const intake = task.artifactRefs?.find((item) => item.type === 'task_intake_record')?.data;
  return { kind: 'intake', task, reply: intake?.nextAction || `已收到任务，任务号：${task.taskId}。请补充具体交付物或发送“检查系统状态”“整理视频 + 链接”“创建一个 Agent”。` };
}

function isOperationsTriageRequest(text) {
  const value = String(text || '');
  return OPERATIONS_TRIAGE_RE.test(value) || (HEALTH_RE.test(value) && /(?:异常|故障|问题|卡住|处理建议|恢复|接手)/i.test(value));
}
function isArchitectureReviewRequest(text) {
  return /(?:复盘|回顾|总结).{0,24}(?:最近|这次|当前|已有)?.{0,24}(?:工作|任务|结果|问题|重复)/.test(String(text || ''));
}
function isCapabilityGapRequest(text) {
  const value = String(text || '');
  return /(?:研究|分析|对比).{0,30}(?:竞品|竞争对手).{0,30}(?:行动清单|行动建议|执行清单)|(?:行动清单|行动建议|执行清单).{0,30}(?:竞品|竞争对手)/.test(value);
}

function directAgentIdentity(agentId) {
  const messages = {
    xiaod:'我是小D。我把已获授权的音视频素材转成可核验的转录和整理文档。',
    'intel-researcher':'我是资料研究员。我只读取公开来源，形成带证据、结论、建议和未决问题的研究报告。',
    'office-assistant':'我是办公执行助理。我把你提供的材料和其他员工的真实结果整理成文档、清单和汇报包。',
    'video-content-analyst':'我是小拆。我只基于可追溯转录证据拆解视频内容，不抓取、不发布。',
    'content-creator':'我是小创。我只根据系统或人工确认稿和正式分析生成平台草稿，不自动发布。',
    operator:'我是运维官。我检查军团运行状态、判断能否安全恢复；不能安全处理的会交给技术专家。',
    creator:'我是创建官。我把岗位需求整理成可审核的智能体草案，不会直接上线或扩权。',
    reviewer:'我是审核官。我核对权限、预算和外部动作的范围；最终敏感决定仍由负责人确认。',
    architect:'我是架构师。我根据真实任务记录评估能力缺口和最小验证方案。',
    'technical-expert':'我是技术专家。我只在有故障证据和受控范围时排查、修复和验证。',
  };
  return { kind:'identity', reply:messages[agentId] || '我是军团的受限岗位智能体，只处理本岗位允许的工作。' };
}

function isRegisteredDraftReviewRequest(text) {
  return /(?:审核|审查).*(?:草案|岗位|员工|agent|智能体|小\s*[gr])/i.test(String(text || ''));
}

function registeredDraftReviewReply(proposal) {
  const manifest = proposal.candidateManifest || {};
  const active = proposal.registryStatus === 'active' || proposal.status === 'active';
  const scopes = (manifest.dataScopes || []).map((item) => `${item.scope || '未命名范围'}（${stringList(item.access).join('、') || '未声明'}）`).join('；') || '未声明';
  const tools = (proposal.requestedCapabilities || []).join('、') || '无';
  const gates = (manifest.qualityGates || []).map((item) => item.gate).filter(Boolean).join('、') || '未声明';
  const reviewer = (proposal.reviewRefs || []).find((item) => item.role === 'reviewer');
  return [
    `【审核官 · ${manifest.name || '草案岗位'}】`,
    `结论：${active ? '已完成在岗权限边界复核' : reviewer?.result === 'needs_scope_before_owner_decision' ? '信息不足，暂不能提交决定' : '已完成范围审查，等待负责人决定'}`,
    `权限：${tools}`,
    `数据范围：${scopes}`,
    `质量门禁：${gates}`,
    `限制：${(manifest.nonResponsibilities || []).join('；') || '无'}`,
    `下一步：${active ? '当前岗位已经上岗；本轮只是只读复核，没有批准、上线或变更任何权限。' : proposal.trialReadiness?.message || reviewer?.summary || '负责人确认后才能进入受限测试；当前仍是草案，不会启用。'}`,
    `草案号：${proposal.proposalId}`
  ].join('\n');
}

function stringList(value) { return (Array.isArray(value) ? value : value ? [value] : []).map((item) => String(item).trim()).filter(Boolean); }

function healthReviewReply(task, report) {
  const components = Array.isArray(report?.components) ? report.components : [];
  const abnormal = components.filter((component) => component?.status && component.status !== 'healthy');
  const evidence = components.length
    ? components.map((component) => `- ${component.name || component.id}：${component.status === 'healthy' ? '正常' : '异常'}；${component.detail || '没有更多详情。'}`)
    : ['- 本次没有取得组件级检查结果。'];
  const healthy = report?.overall === 'healthy' && abnormal.length === 0;
  const conclusion = healthy ? '暂未发现异常。' : `发现 ${abnormal.length || '需要处理的'} 个异常项。`;
  const owner = healthy ? '运维官已完成检查，无需移交。' : '运维官正在按安全边界处理；不能安全恢复的项会交给技术专家。';
  const ownerAction = healthy
    ? '现在不用做什么。若你怀疑某一件具体工作卡住，发任务名称或任务号，我会只查那一件。'
    : (report?.recommendedAction || '暂时不要重置账号、凭据或外部连接；等待运维官的下一次结果。');
  return [
    '【运维官检查结果】',
    `结论：${conclusion}`,
    '依据：', ...evidence,
    `接手：${owner}`,
    `你现在要做：${ownerAction}`,
    `任务号：${task.taskId}`
  ].join('\n');
}

function progressReply(task) {
  const worker = workerName(task);
  const title = `“${shortTitle(task)}”`;
  const report = task.artifactRefs?.find((item) => item.type === 'public_web_report')?.data;
  if (task.status === 'running' || task.status === 'queued') return `${title}正在由${worker}处理。完成后会回到当前飞书会话。`;
  if (task.status === 'succeeded' && !validateTaskCompletion(task).valid) {
    return `${title}已经停止运行，但完成产物没有通过对应任务门禁，已转为待测试。`;
  }
  if (task.status === 'succeeded' && report?.summary) return formatPublicReportReply(report, { taskTitle:shortTitle(task) });
  if (task.status === 'succeeded') return `${title}已经完成，结果已发回当前飞书会话。`;
  if (task.status === 'failed' && task.error?.code === 'executor_failed' && !task.execution?.xiaodJobId) {
    return '这条任务当时没能交到小D处理，现在已经恢复。请重新发送同一个视频链接，我会重新处理。';
  }
  if (task.status === 'failed') return `${title}暂时没有完成：${task.error?.userMessage || `${worker}处理时遇到问题`}。我已保留原因并继续跟进。`;
  if (task.status === 'waiting_test') return `${title}现在是待测试，测试项已记录；其他工作会继续推进。`;
  if (task.status === 'needs_input') return task.error?.userMessage || `${title}还缺少必要信息，暂时不能继续。`;
  if (task.status === 'waiting_approval') return `${title}正在等你确认范围；确认前不会继续。`;
  if (task.status === 'pausing') return `${title}正在暂停，会在当前步骤结束后的安全位置停下。`;
  if (task.status === 'paused') return `${title}已经暂停，确认继续前不会开始新的处理步骤。`;
  return `${title}已收到，正在等待开始处理。`;
}

function mostRelevantTask(tasks) {
  return [...tasks].sort((left, right) => {
    const priority = taskPriority(left.status) - taskPriority(right.status);
    if (priority) return priority;
    return taskTime(right) - taskTime(left);
  })[0] || null;
}

function mostRecentTask(tasks) {
  return [...tasks].sort((left, right) => taskTime(right) - taskTime(left))[0] || null;
}

function progressQueryFor(text) {
  const value = String(text || '').trim();
  const taskId = value.match(TASK_ID_RE)?.[0] || null;
  if (taskId) return { taskId };
  if (!PROGRESS_RE.test(value)) return null;
  const agentId = /(?:小\s*d|小D)/i.test(value) ? 'xiaod' : null;
  return { agentId };
}

function isTaskForAgent(task, agentId) {
  if (task.assigneeAgentId === agentId || task.execution?.executor === agentId) return true;
  return agentId === 'xiaod' && task.taskType === 'media.transcribe-and-refine';
}

function agentDisplayName(agentId) { return agentId === 'xiaod' ? '小D' : agentId; }
function progressHeading(task, agentId, reply) {
  const prefix = agentId ? `【${agentDisplayName(agentId)}任务进度】\n` : '';
  return `${prefix}${reply}\n任务号：${task.taskId}`;
}

function feedbackSentiment(text) {
  // “检查有没有问题”“这个问题怎么修”是在交代工作，不是对上一件工作打分。
  // 评价必须像评价：不带提问或新的执行动作。
  if (/(?:\?|？|检查|查看|怎么|如何|有没有|是否|能否|修复|处理|系统|服务)/i.test(String(text || ''))) return null;
  if (NEGATIVE_FEEDBACK_RE.test(text)) return 'needs_improvement';
  if (POSITIVE_FEEDBACK_RE.test(text)) return 'useful';
  return null;
}

function taskTime(task) { return Date.parse(task.updatedAt || task.createdAt || 0) || 0; }
function workerName(task) {
  if (task.taskType === 'report.public-material') return '公开资料报告员';
  if (task.taskType === 'research.github-search') return '小R';
  if (task.taskType === 'research.intel-report') return '小R';
  if (task.taskType === 'office.briefing-package') return '办公执行助理';
  if (task.taskType === 'office.presentation-package') return '小办';
  if (task.taskType === 'office.knowledge-summary') return '小办';
  if (['content.video-benchmark-analysis', 'content.performance-review'].includes(task.taskType)) return '小拆';
  if (task.taskType === 'content.platform-draft') return '小创';
  if (task.taskType === 'content.video-script-package') return '小创';
  if (task.taskType === 'media.transcribe-and-refine') return '小D';
  if (task.taskType === 'operations.health-review') return '运维官';
  if (task.taskType === 'governance.architecture-review') return '架构师';
  if (task.taskType === 'governance.approval-review') return '审核官';
  if (task.assigneeAgentId === 'technical-expert') return '技术专家';
  return '负责的员工';
}

function shortTitle(task) { return String(task.input?.title || '未命名任务').replace(/\s+/g, ' ').slice(0, 48); }
function uniqueTasks(tasks) { return [...new Map(tasks.map((task) => [shortTitle(task), task])).values()]; }

function isVisibleEmployee(agent) { return agent.agentId !== 'creator'; }

function employeeRole(agent) {
  const roles = {
    xiaod: '负责整理公开视频和音频',
    'public-reporter': '负责读取公开网页并写中文报告',
    'intel-researcher': '负责围绕主题综合公开资料并给行动建议',
    'office-assistant': '负责把材料和员工结果整理成办公汇报包',
    'video-content-analyst': '负责基于确认稿拆解视频内容和复盘表现',
    'content-creator': '负责根据正式分析生成可审核平台草稿',
    operator: '负责检查运行情况和恢复异常',
    reviewer: '负责把关需要你确认的事项',
    architect: '负责评估能力缺口和下一步',
    'technical-expert': '负责排查和修复技术问题',
    creator: '负责准备新员工草案'
  };
  return roles[agent.agentId] || agent.role || '负责已分配的工作';
}

function formatGithubReply(data) {
  if (data.repo) return [`【小R 已读取公开仓库】`, `${data.repo} · ${data.path}`, '', data.summary || '没有可提炼的文本要点。', '', `来源：${data.source || `https://github.com/${data.repo}`}`].join('\n');
  const lines = (data.results || []).map((item, index) => `${index + 1}. ${item.fullName}（★ ${item.stars}，${item.language || '语言未提供'}）\n   ${item.suitability || item.assessment || ''}${item.suitability && item.assessment ? `\n   元数据判断：${item.assessment}` : ''}\n   ${item.url}`);
  return ['【小R 公开 GitHub 检索】', `关键词：${data.query || '未提供'}`, '', ...lines, '', data.conclusion || '仅根据本次读取的公开 GitHub 元数据整理。'].join('\n');
}
function formatIntelReply(report) {
  return ['【小R 研究报告】', `主题：${report.topic || '未提供'}`, '', `背景：${report.background || '仅根据已读取来源整理。'}`, `关键发现：${(report.findings || []).map((item) => `- ${item}`).join('\n') || '- 暂无可确认发现。'}`, `结论：${report.conclusion || '无法仅根据已读取来源确认更多结论。'}`, `行动建议：${(report.recommendations || []).map((item) => `- ${item}`).join('\n') || '- 先补充可公开读取的来源。'}`, `未决问题：${(report.openQuestions || []).map((item) => `- ${item}`).join('\n') || '- 暂无。'}`, '', `来源：${(report.sources || []).map((item) => item.source).filter(Boolean).join('；') || '无'}`].join('\n');
}

function employeeWorkState(agent, tasks) {
  const task = tasks
    .filter((item) => item.assigneeAgentId === agent.agentId)
    .sort((left, right) => taskPriority(left.status) - taskPriority(right.status))[0];
  if (!task) return '当前没有待办';
  const title = `“${shortTitle(task)}”`;
  if (task.status === 'running') return `正在处理${title}`;
  if (task.status === 'queued') return `已接到${title}，等待开始`;
  if (task.status === 'waiting_approval') return `${title}在等你确认范围`;
  if (task.status === 'pausing') return `${title}正在暂停，等待安全位置`;
  if (task.status === 'paused') return `${title}已暂停，等待继续确认`;
  if (task.status === 'waiting_test') return `${title}在待测试，其他工作不受影响`;
  if (task.status === 'needs_input') return `${title}缺少必要信息`;
  if (task.status === 'failed') return `${title}没有完成，故障记录已保留`;
  return `正在跟进${title}`;
}

function employeeStatusText(agent, tasks) {
  const name = agent.name || agent.agentId;
  return `${name}：${employeeWorkState(agent, tasks)}`;
}

function isToday(task) {
  const value = task.updatedAt || task.createdAt;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function taskList(tasks) { return tasks.slice(0, 3).map((task) => `“${shortTitle(task)}”`).join('、') + (tasks.length > 3 ? '等' : ''); }
function taskStatusLine(task) {
  const title = `“${shortTitle(task)}”`;
  if (task.status === 'succeeded') return `${title}已完成`;
  if (task.status === 'running') return `${title}正在处理`;
  if (task.status === 'queued') return `${title}等待开始`;
  if (task.status === 'paused') return `${title}已暂停，等待继续确认`;
  if (task.status === 'pausing') return `${title}正在暂停，等待安全位置`;
  if (task.status === 'waiting_approval') return `${title}在等你确认范围`;
  if (task.status === 'needs_input') return `${title}缺少必要信息`;
  if (task.status === 'waiting_test') return `${title}在待测试，其他工作不受影响`;
  return `${title}暂时没有完成，原因已保留`;
}

function shouldShowInReport(task, byId) {
  if (['operations.technical-repair', 'operations.failure-recovery'].includes(task.taskType)) return false;
  const parent = task.parentTaskId ? byId.get(task.parentTaskId) : null;
  return parent?.taskType !== 'army.cross-agent-mission';
}

function taskPriority(status) { return ({ waiting_approval:0, needs_input:1, failed:2, waiting_test:3, pausing:4, paused:5, running:6, queued:7 })[status] ?? 8; }

function taskStatusLabel(status) {
  return ({ succeeded:'已完成', running:'处理中', queued:'等待开始', waiting_approval:'等你确认', needs_input:'缺少信息', waiting_test:'待测试', failed:'未完成', paused:'已暂停', pausing:'正在暂停', cancelled:'已关闭' })[status] || '状态待更新';
}
function taskUsageTime(task) {
  const value = task.usage?.recordedAt || task.updatedAt || task.createdAt;
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}
function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
function isCurrentConversationContext(context) {
  if (!context || !['usage_report', 'capabilities_menu'].includes(String(context.kind || ''))) return false;
  const expiresAt = Date.parse(context.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt >= Date.now();
}

function isCurrentPendingLinkContext(context) {
  if (String(context?.kind || '') !== 'awaiting_link' || !String(context?.taskType || '').trim()) return false;
  const expiresAt = Date.parse(context.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt >= Date.now();
}
function shouldShowRecentUsageItems(text, context) {
  if (String(context?.kind || '') !== 'usage_report') return false;
  const value = String(text || '').trim();
  return value.length <= 48 && /(?:哪|哪些|明细|具体|展开|刚才|上面|这.*项|那.*项|这.*包括什么|这.*包含什么)/.test(value);
}
function capabilityMenuIntent(text, context) {
  if (String(context?.kind || '') !== 'capabilities_menu') return null;
  const choice = String(text || '').trim();
  if (!/^[1-6]$/.test(choice)) return null;
  return ({ '1':'army_overview', '2':'health_check', '3':'media_task', '4':'public_report', '5':'architecture_review', '6':'agent_proposal_prompt' })[choice] || null;
}

function publicUrl(text) {
  return String(text).match(/https?:\/\/[^\s<>"'，。；：！？、【】（）《》“”‘’]+/i)?.[0]?.replace(/[)\]},.;]+$/, '') || null;
}
function safeRef(value) { return String(value || '').trim().slice(0, 240) || null; }
function safeAgentId(value) {
  const agentId = String(value || '').trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(agentId) ? agentId : null;
}
function safeLoopbackBaseUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return null;
    return parsed.toString().replace(/\/$/, '');
  } catch { return null; }
}
