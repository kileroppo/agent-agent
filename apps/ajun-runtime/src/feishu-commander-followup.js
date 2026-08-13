import {
  isEmployeeStatusQuestion,
  namedEmployeeStatusTarget,
  replyFor,
  progressReply,
  mostRelevantTask,
  mostRecentTask,
  isTaskForAgent,
  agentDisplayName,
  progressHeading,
  taskTime,
  shortTitle,
  uniqueTasks,
  isVisibleEmployee,
  taskStatusLine,
} from './feishu-commander-replies.js';
import { isTaskExecutionClosedStatus } from './task-status-policy.js';

export const feishuCommanderFollowupMethods = {
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
  },

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
  },

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
        reply:`已登记继续飞书交付“${shortTitle(updated)}”。本地确认稿不会重新生成；交付结果会继续回到当前会话。\n任务号：${updated.taskId}。`,
      });
    } catch (error) {
      return { kind:'xiaod_delivery', task, reply:String(error?.message || '飞书交付暂时无法继续；没有启动外部动作。') };
    }
  },

  async explicitEmployeeStatus(text) {
    if (!this.tasks?.overview || !isEmployeeStatusQuestion(text)) return null;
    const overview = await this.tasks.overview();
    const employees = (overview.agents || [])
      .filter((agent) => agent.status === 'active' && isVisibleEmployee(agent))
      .map((agent) => ({ agentId:agent.agentId, name:agent.name || agent.agentId }));
    const agentId = namedEmployeeStatusTarget(text, employees);
    return agentId ? this.employeeStatus(agentId, overview) : null;
  },

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
  },

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
  },

  async recordFeedback(chatRef, text, sentiment) {
    if (!this.store || !chatRef || typeof this.tasks?.recordFeedback !== 'function') {
      return { kind:'task_feedback', reply:'我暂时找不到这条会话里刚完成的工作，暂时没法记录评价。' };
    }
    const tasks = await this.store.list();
    const task = [...tasks]
      .filter((item) => item.source?.channel === 'feishu' && item.source?.chatRef === chatRef && !item.parentTaskId && isTaskExecutionClosedStatus(item.status))
      .sort((left, right) => taskTime(right) - taskTime(left))[0] || null;
    if (!task) return { kind:'task_feedback', reply:'这条会话里暂时没有刚完成的工作可以评价，我没有新建任何任务。' };
    const updated = await this.tasks.recordFeedback(task.taskId, { sentiment, note:text });
    if (sentiment === 'useful') {
      return { kind:'task_feedback', task:updated, reply:`已记下：你觉得“${shortTitle(task)}”这次结果有用。以后遇到类似工作，我会保留这次有效的做法。` };
    }
    return { kind:'task_feedback', task:updated, reply:`已记下：“${shortTitle(task)}”这次结果需要改进。我不会假装已经重做；后续复盘会优先检查这类问题。你想改哪里时，直接说一句就行。` };
  },

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
  },

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
  },

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

};
