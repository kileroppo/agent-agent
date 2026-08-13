import {
  CREATE_AGENT_RE,
  taskRoutingDecision,
  taskTypeForIntent,
  PROGRESS_RE,
  USAGE_RE,
  FOLLOW_UP_RE,
  PAUSE_RE,
  RESUME_RE,
  RETRY_XIAOD_RE,
  CONTINUE_XIAOD_DELIVERY_RE,
  POSITIVE_FEEDBACK_RE,
  NEGATIVE_FEEDBACK_RE,
  HEALTH_RE,
  CAPABILITIES_RE,
  OPERATIONS_TRIAGE_RE,
  MEDIA_RE,
  VIDEO_SCRIPT_RE,
  USE_THIS_VERSION_RE,
  SCRIPT_REVISION_RE,
  OFFICE_RE,
  TASK_ID_RE,
  FeishuCommanderValidationError,
  conversationControlIntent,
  directIntent,
  isDirectReplyWithoutTask,
  isSafePublicResearchRequest,
  isGithubRequest,
  isIntelResearchRequest,
  githubTaskInput,
  githubSearchQuery,
  looksLikeWorkRequest,
  isEmployeeStatusQuestion,
  namedEmployeeStatusTarget,
  compactMention,
  isXiaodLinkRequest,
  linkClarificationPlan,
  formatVideoScriptReply,
  replyFor,
  isOperationsTriageRequest,
  isArchitectureReviewRequest,
  isCapabilityGapRequest,
  directAgentIdentity,
  isRegisteredDraftReviewRequest,
  registeredDraftReviewReply,
  stringList,
  healthReviewReply,
  progressReply,
  mostRelevantTask,
  mostRecentTask,
  isTaskForAgent,
  agentDisplayName,
  progressHeading,
  feedbackSentiment,
  taskTime,
  workerName,
  shortTitle,
  uniqueTasks,
  isVisibleEmployee,
  employeeRole,
  formatGithubReply,
  formatIntelReply,
  employeeWorkState,
  employeeStatusText,
  isToday,
  taskList,
  taskStatusLine,
  shouldShowInReport,
  taskPriority,
  taskStatusLabel,
  taskUsageTime,
  startOfToday,
  isCurrentConversationContext,
  isCurrentPendingLinkContext,
  shouldShowRecentUsageItems,
  capabilityMenuIntent,
  publicUrl,
  safeRef,
  safeAgentId,
  safeLoopbackBaseUrl,
} from './feishu-commander-replies.js';
import { resolveAnalysisIntent } from './analysis-intent.ts';

export const feishuCommanderRoutingMethods = {
  async handle(input) {
    const text = String(input?.text || '').trim();
    const sourceEventRef = String(input?.sourceEventRef || '').trim();
    if (!text) throw new FeishuCommanderValidationError('飞书消息不能为空。');
    if (!sourceEventRef) throw new FeishuCommanderValidationError('飞书消息缺少稳定事件引用，未创建任务。');
    const targetAgentId = safeAgentId(input?.targetAgentId);
    const profileId = safeAgentId(input?.profileId) || targetAgentId || 'ajun';
    const taskCardPolicy = safeTaskCardPolicy(input?.taskCardPolicy);
    const source = {
      channel:'feishu',
      eventRef:sourceEventRef,
      chatRef:safeRef(input?.chatRef),
      ...(targetAgentId ? { targetAgentId } : {}),
      profileId,
      ...(taskCardPolicy ? { taskCardPolicy } : {}),
    };
    const requester = { kind: 'feishu-user', ref: safeRef(input?.requesterRef) || 'feishu-requester' };
    // An explicit "reply here, do not create a task/use tools" instruction is
    // a normal Hermes conversation. Bypass Commander deterministically so a
    // negated phrase such as "不要创建任务" cannot be matched as task creation.
    if (isDirectReplyWithoutTask(text)) {
      return { handled:false, reason:'explicit_direct_reply_without_task' };
    }
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
    // 先用一个结构化决定消解“创建新任务”和“查询旧任务”的冲突；后续路由
    // 只消费 action，不再靠多个分支各自重复猜测用户是否引用了已有任务。
    const taskDecision = taskRoutingDecision(text);
    if (taskDecision?.action === 'create_task') {
      return this.handlePlannedIntent(
        { intent:taskDecision.intent, taskType:taskDecision.taskType },
        { text, sourceEventRef, source, requester, targetAgentId }
      );
    }
    if (taskDecision?.action === 'query_task') return this.taskProgress(source.chatRef, taskDecision.query);
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
  },

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
  },

  async reviewRegisteredDrafts(text) {
    if (typeof this.proposals?.reviewRegisteredDrafts !== 'function') return this.clarify('请发需要审核的任务号或新员工草案编号，并说明你希望我核对的范围。');
    const proposals = await this.proposals.reviewRegisteredDrafts(text);
    if (!proposals.length) return this.clarify('没有找到你点名的草案岗位。请直接说岗位名称，例如“小R”。');
    return {
      kind:'registered_draft_review', proposals,
      reply:proposals.map((proposal) => registeredDraftReviewReply(proposal)).join('\n\n')
    };
  },

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
  },

  async directAgentIntent(agentId, text) {
    if (typeof this.planner?.decide !== 'function') return null;
    try { return await this.planner.decide(text, { agentId }); }
    catch { return null; }
  },

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
    const taskType = plan.taskType || taskTypeForIntent(intent);
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
            reviewPolicy:'optional', evidenceMode:'formal', analysisIntent:analysis.analysisIntent, depth:analysis.depth, visualMode:'auto',
          },
          {
            key:'analyze-video', title:text, taskType:'content.video-benchmark-analysis', agentId:'video-content-analyst',
            description:'只在确认稿存在后生成对应模式的证据化分析。',
            acceptance:'所有关键内容绑定字幕片段、时间点或画面证据。', sourceUrls:[analysisUrl],
            reviewPolicy:'optional', evidenceMode:'formal', analysisIntent:analysis.analysisIntent, depth:analysis.depth, visualMode:'auto',
            dependsOnPrevious:true, dependsOn:['acquire-transcript'],
          },
        ],
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
  },

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
  },

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
  },

  clarify(reply = '') {
    return {
      kind:'clarify',
      reply:String(reply || '我还没听清你希望我做什么。直接说你想拿到什么结果、给谁用，或者发链接/材料给我；能直接办的我会安排，不能直接办的我会先说明缺什么。').trim()
    };
  },

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
  },

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

};

function safeTaskCardPolicy(value) {
  const policy = String(value || '').trim();
  return ['disabled', 'routed-task', 'durable-task', 'incident-only'].includes(policy) ? policy : '';
}
