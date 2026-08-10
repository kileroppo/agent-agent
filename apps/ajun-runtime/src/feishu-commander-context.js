import {
  CREATE_AGENT_RE,
  PROGRESS_RE,
  USAGE_RE,
  FOLLOW_UP_RE,
  PAUSE_RE,
  RESUME_RE,
  RETRY_XIAOD_RE,
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
  progressQueryFor,
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
  employeeCapabilityTruth,
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

export const feishuCommanderContextMethods = {
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
      ? frontLineAgents.map((agent) => `- ${names[agent.agentId]}：${employeeRole(agent)}；${employeeWorkState(agent, activeTasks)}；${employeeCapabilityTruth(agent)}`)
      : ['- 目前还没有能直接交付工作的员工。'];
    const supportLines = supportAgents.length
      ? supportAgents.map((agent) => `- ${names[agent.agentId]}：${employeeRole(agent)}；${employeeWorkState(agent, activeTasks)}；${employeeCapabilityTruth(agent)}`)
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
  },

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
        '【当前可受理的工作】',
        ...abilities.map((item, index) => `${index + 1}. ${item}`),
        '',
        '你只要直接说想要的结果，不用记固定说法。是否可完成以这次 Workflow 的真实产物为准；当前没有合适员工时，我会先评估怎么补。'
      ].join('\n')
    };
  },

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
  },

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
  },

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
  },

  async rememberUsageContext(chatRef, usage, tasks) {
    if (!this.store?.setConversationContext || !chatRef) return;
    const now = new Date();
    const taskIds = tasks.map((task) => task.taskId).filter(Boolean).slice(0, 40);
    await this.store.setConversationContext(chatRef, {
      kind:'usage_report', createdAt:now.toISOString(), expiresAt:new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      recordedTaskCount:Number(usage?.trackedTaskCount || 0), actualToolCalls:Number(usage?.actualToolCalls || 0), taskIds
    });
  },

  async rememberCapabilitiesContext(chatRef, abilities) {
    if (!this.store?.setConversationContext || !chatRef) return;
    const now = new Date();
    await this.store.setConversationContext(chatRef, {
      kind:'capabilities_menu', createdAt:now.toISOString(), expiresAt:new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      optionCount:abilities.length
    });
  },

  async rememberPendingLink(chatRef, pending) {
    if (!this.store?.setConversationContext || !chatRef || !pending?.taskType) return;
    const now = new Date();
    await this.store.setConversationContext(chatRef, {
      kind:'awaiting_link', createdAt:now.toISOString(), expiresAt:new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      taskType:String(pending.taskType), agentId:safeAgentId(pending.agentId)
    });
  },

  async handlePendingLink(text, { sourceEventRef, source, requester, targetAgentId }) {
    if (!publicUrl(text) || !this.store?.getConversationContext || !source.chatRef) return null;
    const context = await this.store.getConversationContext(source.chatRef);
    if (!isCurrentPendingLinkContext(context)) return null;
    return this.handlePlannedIntent(
      { intent:'route_task', taskType:context.taskType, agentId:safeAgentId(context.agentId) || undefined },
      { text, sourceEventRef, source, requester, targetAgentId }
    );
  },

  async todayUsageTasks() {
    if (!this.store?.list) return [];
    const since = startOfToday();
    return (await this.store.list()).filter((task) => task.usage?.schemaVersion === 'agent.army/task-usage/v1' && taskUsageTime(task) >= since);
  },

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
  },

  async intentFor(text) {
    if (VIDEO_SCRIPT_RE.test(text)) return { intent:'route_task', taskType:'content.video-script-package', agentId:'content-creator' };
    const direct = highConfidenceReadonlyDirectIntent(text);
    if (direct) return direct;
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
    const fallback = directIntent(text);
    if (fallback.intent !== 'intake') return fallback;
    // AI 偶尔会把“查公开竞品”保守地归成普通待办。这个兜底只接住
    // 目标明确、且没有登录/付费/外发风险的公开资料请求，避免负责人反复补链接。
    if (isGithubRequest(text)) return { intent:'github_search' };
    if (isIntelResearchRequest(text)) return { intent:'intel_research' };
    if (isSafePublicResearchRequest(text)) return { intent:'public_report' };
    // AI 临时不可用时，也不能把一句闲聊、编号或模糊追问登记为一项
    // “泛任务”。只有看上去确实在交代工作时，才交给现有的能力评估流程。
    return looksLikeWorkRequest(text) ? fallback : { intent:'clarify' };
  },

  async availableRoutes() {
    if (!this.tasks?.overview) return [];
    const overview = await this.tasks.overview();
    return (overview.agents || []).filter((agent) => agent.status === 'active' && isVisibleEmployee(agent)).flatMap((agent) => (agent.acceptedTaskTypes || []).map((taskType) => ({ taskType, agentId:agent.agentId, name:agent.name || agent.agentId })));
  },

  async availableEmployees() {
    if (!this.tasks?.overview) return [];
    const overview = await this.tasks.overview();
    return (overview.agents || [])
      .filter((agent) => agent.status === 'active' && isVisibleEmployee(agent))
      .map((agent) => ({ agentId:agent.agentId, name:agent.name || agent.agentId }));
  },

  completionWatchFor(result) {
    const taskId = String(result?.task?.taskId || '').trim();
    const status = String(result?.task?.status || '').trim();
    const recoveryStarted = status === 'failed'
      && ['pending', 'retrying', 'escalated'].includes(String(result?.task?.recovery?.coordination?.status || ''));
    if (!taskId || (!['queued', 'running'].includes(status) && !recoveryStarted) || !this.ajunBaseUrl) return result;
    return { ...result, completionWatch: { kind:'ajun_task', taskId, baseUrl:this.ajunBaseUrl } };
  }
};

function highConfidenceReadonlyDirectIntent(text) {
  const direct = directIntent(text);
  if (isHighConfidenceReadonlyHealthQuestion(text)) return { intent:'health_check' };
  if (isHighConfidenceReadonlyOverviewQuestion(text)) return { intent:'army_overview' };
  if (isHighConfidenceReadonlyUsageQuestion(text)) return { intent:'usage_report' };
  if (isHighConfidenceReadonlyArmyReportQuestion(text)) return { intent:'army_report' };
  switch (direct?.intent) {
    case 'identity':
    case 'army_capabilities':
      return direct;
    default:
      return null;
  }
}

function isHighConfidenceReadonlyHealthQuestion(text) {
  const value = String(text || '').trim();
  return isOperationsTriageRequest(value)
    || /^(?:帮我|麻烦你|请)?(?:检查|看下|看看|查下|查一下).{0,24}(?:系统|军团|服务|运行|健康|状态).{0,12}(?:有没有问题|是否正常|情况)?[。！!？?]?$/.test(value)
    || /^(?:系统|军团|服务|运行|健康|状态).{0,18}(?:正常吗|有没有问题|如何|怎么样|什么情况)[。！!？?]?$/.test(value);
}

function isHighConfidenceReadonlyOverviewQuestion(text) {
  const value = String(text || '').trim();
  return /^(?:现在|目前)?(?:大家|军团|员工).{0,24}(?:都在干嘛|都在做什么|在做什么|谁在做什么|什么情况|状态如何|谁卡住了)[。！!？?]?$/.test(value)
    || /^(?:今天|现在|目前).{0,24}(?:有什么|哪些).{0,18}(?:需要我|要我).{0,12}(?:处理|决定|确认|补充)[。！!？?]?$/.test(value)
    || /^(?:现在|目前|当前)?(?:一共|总共|有)?多少(?:个|名)?(?:员工|agent|助手)(?:在岗|在线|可用)?[。！!？?]?$/.test(value);
}

function isHighConfidenceReadonlyUsageQuestion(text) {
  const value = String(text || '').trim();
  return /^(?:今天|今日).{0,8}(?:花了多少|用了多少|用量多少|消耗多少|成本多少|费用多少|token用了多少)[。！!？?]?$/.test(value)
    || /^(?:看下|看看|查下|查一下|给我).{0,8}(?:今天|今日).{0,8}(?:用量|消耗|成本|费用|实际使用)[。！!？?]?$/.test(value)
    || /^(?:今天|今日).{0,8}(?:实际使用|使用情况)(?:怎么样|如何|是什么|多少|呢)?[。！!？?]?$/.test(value);
}

function isHighConfidenceReadonlyArmyReportQuestion(text) {
  const value = String(text || '').trim();
  return /^(?:给我|看下|看看|查下|查一下).{0,8}(?:今天|今日).{0,8}(?:军团|工作).{0,8}(?:工作汇报|工作总结|日报|汇报)[。！!？?]?$/.test(value)
    || /^(?:今天|今日).{0,8}(?:完成了什么|做了什么|干了什么|工作情况)[。！!？?]?$/.test(value)
    || /^(?:给我|看下|看看|查下|查一下).{0,8}(?:今天|今日).{0,8}(?:完成了什么|做了什么|干了什么)[。！!？?]?$/.test(value);
}
