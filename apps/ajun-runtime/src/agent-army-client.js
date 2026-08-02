import crypto from 'node:crypto';
import { presentTask, taskDetailBaseUrl } from './task-presentation.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'waiting_test', 'needs_input', 'paused']);

export class AgentArmyClient {
  constructor({
    baseUrl = process.env.AGENT_ARMY_BASE_URL || 'http://127.0.0.1:4321',
    fetchImpl = globalThis.fetch,
    timeoutSignalImpl = (ms) => AbortSignal.timeout(ms),
    now = () => Date.now(),
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    missionWaitMs = Number(process.env.AGENT_ARMY_MISSION_WAIT_MS || 45_000),
    missionPollMs = Number(process.env.AGENT_ARMY_MISSION_POLL_MS || 1_000),
    detailBaseUrl = process.env.AJUN_TASK_DETAIL_BASE_URL || ''
  } = {}) {
    this.baseUrl = loopbackBaseUrl(baseUrl);
    this.detailBaseUrl = taskDetailBaseUrl(detailBaseUrl, this.baseUrl);
    if (typeof fetchImpl !== 'function') throw new AgentArmyClientError('Agent Army MCP 缺少 HTTP 客户端。');
    this.fetchImpl = fetchImpl;
    this.timeoutSignal = timeoutSignalImpl;
    this.now = now;
    this.sleep = sleepImpl;
    this.missionWaitMs = boundedDuration(missionWaitMs, 0, 120_000, 45_000);
    this.missionPollMs = boundedDuration(missionPollMs, 50, 10_000, 1_000);
  }

  async capabilities() {
    const overview = await this.overview();
    return {
      capabilities: (overview.capabilities || []).map(capabilityView),
      employees: (overview.agents || []).filter((agent) => agent.status === 'active').map(employeeCapabilityView)
    };
  }

  async armyStatus() {
    const overview = await this.overview();
    return {
      taskFocus: overview.taskFocus || {},
      usage: overview.usage || {},
      capabilities: (overview.capabilities || []).map(capabilityView),
      employees: (overview.agents || []).map((agent) => ({
        agentId: agent.agentId,
        name: agent.name || agent.agentId,
        status: agent.status,
        feishuChannel: safeChannel(agent.feishuChannel)
      }))
    };
  }

  async employeeStatus(employee) {
    const overview = await this.overview();
    const agent = findEmployee(overview.agents || [], employee);
    if (!agent) throw new AgentArmyClientError(`没有找到员工“${safeText(employee, 80)}”。`);
    const recentTasks = (overview.tasks || [])
      .filter((task) => task.assigneeAgentId === agent.agentId || task.routing?.requestedAgentId === agent.agentId)
      .sort(newestFirst)
      .slice(0, 5)
      .map((task) => taskView(task, overview.approvals || [], this.detailBaseUrl));
    return {
      agentId: agent.agentId,
      name: agent.name || agent.agentId,
      status: agent.status,
      role: safeText(agent.role, 300),
      responsibilities: safeStringList(agent.responsibilities, 8, 240),
      acceptedTaskTypes: safeStringList(agent.acceptedTaskTypes, 20, 120),
      recentTasks
    };
  }

  async listTasks({ status = null, employee = null, limit = 10 } = {}) {
    const overview = await this.overview();
    const agent = employee ? findEmployee(overview.agents || [], employee) : null;
    if (employee && !agent) throw new AgentArmyClientError(`没有找到员工“${safeText(employee, 80)}”。`);
    const wantedStatuses = normalizeStatuses(status);
    return (overview.tasks || [])
      .filter((task) => !wantedStatuses.length || wantedStatuses.includes(task.status))
      .filter((task) => !agent || task.assigneeAgentId === agent.agentId || task.routing?.requestedAgentId === agent.agentId)
      .sort(newestFirst)
      .slice(0, boundedLimit(limit))
      .map((task) => taskView(task, overview.approvals || [], this.detailBaseUrl));
  }

  async getTask(taskId, { chatRef = '' } = {}) {
    const id = requiredId(taskId, '任务编号无效。');
    const overview = await this.overview();
    const task = (overview.tasks || []).find((item) => item.taskId === id);
    if (!task) throw new AgentArmyClientError('没有找到这条任务。');
    let notification = null;
    try {
      notification = await this.request('/api/feishu/task-status', {
        method: 'POST',
        body: { taskId:id, chatRef:safeText(chatRef, 240) }
      });
    } catch (error) {
      if (chatRef || !String(error?.message || '').includes('当前会话不能读取')) throw error;
    }
    return {
      ...taskView(task, overview.approvals || [], this.detailBaseUrl),
      terminal: notification?.terminal ?? TERMINAL_STATUSES.has(task.status),
      userMessage: safeText(notification?.message || task.error?.userMessage || '', 2000)
    };
  }

  async createTask(input = {}) {
    const title = safeText(input.title, 500);
    const taskType = safeText(input.taskType, 120);
    if (!title) throw new AgentArmyClientError('请说明要完成什么。');
    if (!taskType) throw new AgentArmyClientError('请提供任务类型；不确定时先调用 capabilities。');
    const description = safeText(input.description, 2000);
    const chatRef = safeText(input.chatRef, 240);
    const requestRef = safeText(input.requestRef, 240);
    const sourceUrls = safeStringList(input.sourceUrls, 5, 2000);
    const sourceTaskIds = safeStringList(input.sourceTaskIds, 20, 100);
    const connectionId = optionalConnectionId(input.connectionId);
    const goalSpec = normalizeGoalSpecInput(input.goalSpec);
    const evidenceMode = input.evidenceMode === 'preliminary' ? 'preliminary' : 'formal';
    const depth = requestedAnalysisDepth({ title, description, depth:input.depth });
    const visualMode = input.visualMode === undefined
      ? taskType === 'content.video-benchmark-analysis' ? 'auto' : 'off'
      : normalizeVisualMode(input.visualMode);
    if (taskType === 'content.video-benchmark-analysis' && sourceUrls.length && !sourceTaskIds.length) {
      return this.createMission({
        title:`${title}｜受控获取与拆解`,
        chatRef,
        requestRef,
        waitForTerminal:false,
        items:[
          {
            key:'acquire-transcript',
            title:`获取并整理：${title}`,
            taskType:'media.transcribe-and-refine',
            agentId:'xiaod',
            description:'只能通过内容获取中心获取公开或已授权素材；优先复用字幕，必要时才转录。',
            acceptance:evidenceMode === 'formal'
              ? input.reviewPolicy === 'required'
                ? '生成来源证据、质量报告和机器稿，并按用户要求等待真人完整听审确认。'
                : '生成来源证据和质量报告；质量门禁通过时自动生成系统确认稿，异常时才等待人工听审。'
              : '生成来源证据、质量报告和可供初步分析使用的机器稿。',
            sourceUrls,
            connectionId,
            reviewPolicy:input.reviewPolicy === 'required' ? 'required' : 'optional',
            visualMode,
            depth
          },
          {
            key:'analyze-video',
            title,
            taskType,
            agentId:'video-content-analyst',
            description,
            acceptance:evidenceMode === 'formal'
              ? '只在系统质量确认稿或人工确认稿存在后生成带证据的正式拆解。'
              : '基于机器稿生成明确降级的初步拆解。',
            dependsOnPrevious:true,
            evidenceMode,
            depth,
            visualMode,
            focus:safeText(input.focus, 500)
          }
        ]
      });
    }
    const idempotencyKey = requestRef
      ? `hermes:${requestRef}`
      : `hermes:${chatRef || 'local'}:${shortHash([title, taskType, input.agentId || '', Math.floor(this.now() / 30_000)].join('|'))}`;
    const source = chatRef
      ? { channel:'feishu', chatRef, messageRef:requestRef || undefined }
      : { channel:'hermes-native' };
    const response = await this.request('/api/tasks', {
      method:'POST',
      body:{
        title,
        description,
        taskType,
        agentId:safeText(input.agentId, 80) || undefined,
        sourceUrls,
        connectionId,
        reviewPolicy:input.reviewPolicy === 'required' ? 'required' : 'optional',
        evidenceMode,
        depth,
        visualMode,
        focus:safeText(input.focus, 500) || undefined,
        platforms:safeStringList(input.platforms, 10, 40),
        contentGoal:safeText(input.contentGoal, 500) || undefined,
        durationSeconds:Number.isFinite(Number(input.durationSeconds)) ? Number(input.durationSeconds) : undefined,
        researchMode:input.researchMode === 'off' ? 'off' : 'auto',
        approvedForUse:input.approvedForUse === true,
        sourceScriptTaskId:safeText(input.sourceScriptTaskId, 100) || undefined,
        metrics:safeMetrics(input.metrics),
        requester:{ kind:'local-owner', ref:'A君' },
        requesterName:'A君',
        source,
        goalSpec:goalSpec || undefined,
        context:{
          ...(sourceTaskIds.length ? { sourceTaskIds, dependsOnPrevious:true } : {}),
          ...(goalSpec ? { autonomousOpenTask:true } : {})
        },
        idempotencyKey
      }
    });
    await this.registerCompletionWatch(response.task?.taskId, chatRef);
    return this.getTask(response.task?.taskId, { chatRef });
  }

  async createMission(input = {}) {
    const title = safeText(input.title, 500);
    const items = normalizeMissionItems(input.items);
    if (!title) throw new AgentArmyClientError('请说明这组工作的总目标。');
    if (!items.length) throw new AgentArmyClientError('多人任务必须包含 1 到 11 项有效员工分工，并且依赖项必须引用同一任务中的 key。');
    const chatRef = safeText(input.chatRef, 240);
    const requestRef = safeText(input.requestRef, 240);
    const idempotencyKey = requestRef
      ? `hermes-mission:${requestRef}`
      : `hermes-mission:${chatRef || 'local'}:${shortHash([title, JSON.stringify(items), Math.floor(this.now() / 30_000)].join('|'))}`;
    const source = chatRef
      ? { channel:'feishu', chatRef, messageRef:requestRef || undefined }
      : { channel:'hermes-native' };
    const response = await this.request('/api/mcp/missions', {
      method:'POST',
      body:{
        title,
        items,
        requester:{ kind:'local-owner', ref:'A君' },
        source,
        idempotencyKey
      }
    });
    await this.registerCompletionWatch(response.mission?.taskId, chatRef);
    let overview = await this.overview();
    let missionTask = findMissionTask(overview, response);
    if (input.waitForTerminal === true && missionTask && !TERMINAL_STATUSES.has(missionTask.status)) {
      const maxPolls = Math.ceil(this.missionWaitMs / this.missionPollMs);
      for (let poll = 0; poll < maxPolls && !TERMINAL_STATUSES.has(missionTask.status); poll += 1) {
        await this.sleep(this.missionPollMs);
        overview = await this.overview();
        missionTask = findMissionTask(overview, response);
      }
    }
    const missionId = missionTask?.taskId || response.mission?.taskId;
    const childIds = new Set((response.children || []).map((task) => task.taskId));
    const children = (overview.tasks || []).filter((task) => (
      task.parentTaskId === missionId || childIds.has(task.taskId)
    ));
    const missionView = taskView(missionTask, overview.approvals || [], this.detailBaseUrl);
    return {
      mission:missionView,
      children:children.map((task) => taskView(task, overview.approvals || [], this.detailBaseUrl)),
      userMessage:missionResultMessage(missionView, response.reply)
    };
  }

  async registerCompletionWatch(taskId, chatRef) {
    const task = safeText(taskId, 100);
    const chat = safeText(chatRef, 240);
    if (!task || !chat) return { registered:false };
    try {
      return await this.request('/api/mcp/completion-watches', {
        method:'POST',
        body:{ taskId:task, chatRef:chat }
      });
    } catch {
      // 任务已成功创建时，通知登记暂时失败不能篡改任务事实。
      // 用户仍可通过 task_get 查询；运行台恢复后下一次请求会幂等补登记。
      return { registered:false };
    }
  }

  async controlTask(taskId, action) {
    const id = requiredId(taskId, '任务编号无效。');
    const normalized = String(action || '').trim().toLowerCase();
    if (!['pause', 'resume'].includes(normalized)) throw new AgentArmyClientError('任务控制只支持 pause 或 resume。');
    const response = await this.request(`/api/mcp/tasks/${encodeURIComponent(id)}/${normalized}`, { method:'POST', body:{} });
    const overview = await this.overview();
    return {
      task:taskView(response.task, overview.approvals || [], this.detailBaseUrl),
      approval:response.approval ? approvalView(response.approval) : null,
      duplicate:response.duplicate === true
    };
  }

  async listApprovals({ status = 'pending', limit = 10 } = {}) {
    const overview = await this.overview();
    const normalized = String(status || '').trim();
    return (overview.approvals || [])
      .filter((approval) => !normalized || normalized === 'all' || approval.status === normalized)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, boundedLimit(limit))
      .map(approvalView);
  }

  async resolveApproval(approvalId, decision) {
    const id = requiredId(approvalId, '审批编号无效。');
    const normalized = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalized)) throw new AgentArmyClientError('审批决定只支持 approve 或 reject。');
    const response = await this.request(`/api/mcp/approvals/${encodeURIComponent(id)}/${normalized}`, { method:'POST', body:{} });
    const overview = await this.overview();
    return {
      task:taskView(response.task, overview.approvals || [], this.detailBaseUrl),
      approval:approvalView((overview.approvals || []).find((approval) => approval.approvalId === id) || { approvalId:id, status:normalized === 'approve' ? 'approved' : 'rejected' })
    };
  }

  async getPaperclipAssignment(input = {}) {
    const response = await this.request('/api/mcp/paperclip-assignment', {
      method:'POST',
      body:paperclipAssignmentIdentity(input),
      paperclipApiKey:process.env.PAPERCLIP_API_KEY
    });
    return {
      assignment:{
        issueId:safeText(response.assignment?.issueId, 128),
        identifier:safeText(response.assignment?.identifier, 80) || null,
        title:safeText(response.assignment?.title, 500),
        description:safeText(response.assignment?.description, 4000),
        agentId:safeText(response.assignment?.agentId, 80),
        runId:safeText(response.assignment?.runId, 128),
        ...(response.assignment?.agentId === 'architect'
          ? { groundTruth:architectureGroundTruthView(response.assignment?.groundTruth) }
          : {})
      },
      task:{
        taskId:safeText(response.task?.taskId, 128),
        taskType:safeText(response.task?.taskType, 120),
        status:safeText(response.task?.status, 60),
        currentStage:safeText(response.task?.currentStage, 120),
        ...(response.task?.input?.context?.m5Recovery
          ? { m5Recovery:m5RecoveryView(response.task.input.context.m5Recovery) }
          : {}),
        ...(response.assignment?.agentId === 'technical-expert'
          ? {
              repairScope:technicalRepairScopeView(response.task?.input?.context?.repairScope),
              diagnosis:technicalDiagnosisView(response.task?.input?.context)
            }
          : {})
      }
    };
  }

  async completePaperclipAssignment(input = {}) {
    return this.request('/api/mcp/paperclip-assignment/complete', {
      method:'POST',
      body:{
        ...paperclipAssignmentIdentity(input),
        status:safeText(input.status || 'succeeded', 40),
        summary:safeText(input.summary, 4000),
        evidence:safeText(input.evidence, 4000),
        remainingRisks:safeText(input.remainingRisks, 2000),
        evidenceRefs:architectureEvidenceRefsView(input.evidenceRefs),
        unverifiedClaims:safeStringList(input.unverifiedClaims, 20, 1000),
        factClaims:architectureFactClaimsView(input.factClaims),
        architectureJudgments:architectureJudgmentsView(input.architectureJudgments),
        candidateProposals:architectureCandidateProposalsView(input.candidateProposals),
        currentStateUnknowns:safeStringList(input.currentStateUnknowns, 20, 1000),
        consumedRevisionId:safeText(input.consumedRevisionId, 240)
      },
      paperclipApiKey:process.env.PAPERCLIP_API_KEY
    });
  }

  async executeAgentProposal(input = {}) {
    return this.request('/api/mcp/agent-proposal-execute', {
      method:'POST',
      body:{
        ...paperclipAssignmentIdentity(input),
        requestedOutcome:safeText(input.requestedOutcome, 500),
        candidateName:safeText(input.candidateName, 120),
        agentId:safeText(input.agentId, 80),
        department:safeText(input.department, 120),
        responsibilities:safeStringList(input.responsibilities, 8, 500),
        nonResponsibilities:safeStringList(input.nonResponsibilities, 10, 500),
        acceptedTaskTypes:safeStringList(input.acceptedTaskTypes, 8, 120),
        desiredSkills:safeStringList(input.desiredSkills, 8, 120),
        requestedCapabilities:safeStringList(input.requestedCapabilities, 8, 120),
        acceptanceTitle:safeText(input.acceptanceTitle, 500)
      },
      paperclipApiKey:process.env.PAPERCLIP_API_KEY
    });
  }

  async executeTechnicalRepair(input = {}) {
    return this.request('/api/mcp/technical-repair-execute', {
      method:'POST',
      body:paperclipAssignmentIdentity(input),
      paperclipApiKey:process.env.PAPERCLIP_API_KEY,
      timeoutMs:180_000
    });
  }

  async executeOperationsHealth(input = {}) {
    return this.request('/api/mcp/operations-health-execute', {
      method:'POST',
      body:paperclipAssignmentIdentity(input),
      paperclipApiKey:process.env.PAPERCLIP_API_KEY
    });
  }

  async executeEmployeeAssignment(input = {}) {
    return this.request('/api/mcp/employee-assignment-execute', {
      method:'POST',
      body:paperclipAssignmentIdentity(input),
      paperclipApiKey:process.env.PAPERCLIP_API_KEY,
      timeoutMs:270_000
    });
  }

  async executeContentGrowth(input = {}) {
    return this.request('/api/mcp/content-growth-execute', {
      method:'POST',
      body:paperclipAssignmentIdentity(input),
      paperclipApiKey:process.env.PAPERCLIP_API_KEY,
      // 12 分钟业务预算由 A君后台运行持有；单次 Hermes MCP 等待必须
      // 小于其 300 秒同步桥上限，超时前返回 running 并由同一工具续等。
      timeoutMs:270_000
    });
  }

  async executeM5Stage(input = {}) {
    return this.request('/api/mcp/m5-stage-execute', {
      method:'POST',
      body:paperclipAssignmentIdentity(input),
      paperclipApiKey:process.env.PAPERCLIP_API_KEY,
      timeoutMs:270_000,
    });
  }

  async overview() {
    return this.request('/api/overview');
  }

  async request(pathname, { method = 'GET', body = null, paperclipApiKey = '', timeoutMs = 30_000 } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers:{
          ...(body ? { 'content-type':'application/json' } : {}),
          ...(paperclipApiKey ? { authorization:`Bearer ${paperclipApiKey}` } : {})
        },
        body:body ? JSON.stringify(body) : undefined,
        signal:this.timeoutSignal(Math.max(1_000, Math.min(Number(timeoutMs) || 30_000, 900_000)))
      });
    } catch (error) {
      throw new AgentArmyClientError(`A君运行时不可用：${safeText(error?.message || '连接失败', 240)}`);
    }
    let payload = {};
    try { payload = await response.json(); }
    catch { /* HTTP status below remains the authoritative failure. */ }
    if (!response.ok) throw new AgentArmyClientError(safeText(payload?.error || `A君运行时返回 HTTP ${response.status}`, 500));
    return payload;
  }
}

function requestedAnalysisDepth({ title, description, depth }) {
  const requestText = `${String(title || '')}\n${String(description || '')}`;
  if (/完整.{0,8}(?:拆解|分析)|(?:拆解|分析).{0,8}完整|13\s*模块/u.test(requestText)) return 'full';
  return depth === 'full' ? 'full' : 'fast';
}

function normalizeVisualMode(value) {
  return value === 'off' || value === 'required' ? value : 'auto';
}

export class AgentArmyClientError extends Error {}

function loopbackBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new AgentArmyClientError('Agent Army MCP 地址无效。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new AgentArmyClientError('Agent Army MCP 只允许连接本机 loopback HTTP 服务。');
  }
  return url.origin;
}

function paperclipAssignmentIdentity(input) {
  return {
    issueId:safeText(input.issueId, 128),
    runId:safeText(input.runId, 128),
    paperclipAgentId:safeText(input.paperclipAgentId, 128),
    agentArmyId:safeText(input.agentArmyId, 80)
  };
}

function safeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [
    safeText(key, 80),
    typeof item === 'number' || typeof item === 'boolean' ? item : safeText(item, 120)
  ]).filter(([key, item]) => key && item !== ''));
}

function technicalRepairScopeView(scope = {}) {
  return {
    files:safeStringList(scope?.files, 4, 500),
    testCommand:safeText(scope?.testCommand, 1000),
    recoveryCheck:safeText(scope?.recoveryCheck, 1000)
  };
}

function technicalDiagnosisView(context = {}) {
  const diagnosis = context?.diagnosis || {};
  const classification = context?.failureClassification || {};
  return {
    route:safeText(context?.technicalRoute || classification.route, 120),
    failureClass:safeText(diagnosis.failureClass || classification.failureClass, 120),
    summary:safeText(diagnosis.summary || diagnosis.reason || classification.reason, 800),
    evidence:safeStringList(diagnosis.evidence, 8, 500),
    nextAction:safeText(diagnosis.nextAction, 800),
    failure:{
      code:safeText(context?.failure?.code, 120),
      category:safeText(context?.failure?.category, 80),
      stage:safeText(context?.failure?.stage, 120),
      message:safeText(context?.failure?.message, 800)
    }
  };
}

function m5RecoveryView(value = {}) {
  return {
    schemaVersion:safeText(value.schemaVersion, 120),
    revisionId:safeText(value.revisionId, 240),
    revision:Number.isInteger(Number(value.revision)) ? Number(value.revision) : null,
    failedCaseId:safeText(value.failedCaseId, 128),
    failureObservation:{
      issueId:safeText(value.failureObservation?.issueId, 128),
      runId:safeText(value.failureObservation?.runId, 128),
      stageKey:safeText(value.failureObservation?.stageKey, 80),
      summary:safeText(value.failureObservation?.summary, 500),
      summaryHash:safeText(value.failureObservation?.summaryHash, 80),
    },
    rejectedRoute:{
      kind:safeText(value.rejectedRoute?.kind, 120),
      reason:safeText(value.rejectedRoute?.reason, 500),
      ...(value.rejectedRoute?.routeFingerprint ? {
        routeFingerprint:safeText(value.rejectedRoute.routeFingerprint, 80),
        execution:{
          strategy:safeText(value.rejectedRoute?.execution?.strategy, 160),
          toolIds:safeStringList(value.rejectedRoute?.execution?.toolIds, 20, 240),
          inputHash:safeText(value.rejectedRoute?.execution?.inputHash, 80),
        },
      } : {}),
    },
    nextRoute:{
      kind:safeText(value.nextRoute?.kind, 120),
      stageKey:safeText(value.nextRoute?.stageKey, 80),
      preserveVerifiedWorkProducts:value.nextRoute?.preserveVerifiedWorkProducts === true,
      instruction:safeText(value.nextRoute?.instruction, 1000),
    },
  };
}

function architectureGroundTruthView(value = {}) {
  return {
    schemaVersion:safeText(value?.schemaVersion, 100),
    snapshotId:safeText(value?.snapshotId, 128),
    generatedAt:safeText(value?.generatedAt, 80),
    limitation:safeText(value?.limitation, 500),
    agents:(Array.isArray(value?.agents) ? value.agents : []).slice(0, 30).map((item) => ({
      ref:safeText(item?.ref, 120),
      agentId:safeText(item?.agentId, 80),
      name:safeText(item?.name, 120),
      status:safeText(item?.status, 40),
      acceptedTaskTypes:safeStringList(item?.acceptedTaskTypes, 20, 120),
      toolAllowlist:safeStringList(item?.toolAllowlist, 30, 160),
      repositoryRefs:safeStringList(item?.repositoryRefs, 6, 500)
    })),
    taskTypes:(Array.isArray(value?.taskTypes) ? value.taskTypes : []).slice(0, 100).map((item) => ({
      ref:safeText(item?.ref, 180),
      taskType:safeText(item?.taskType, 120),
      agentIds:safeStringList(item?.agentIds, 20, 80),
      taskCount:Number(item?.taskCount || 0)
    })),
    taskSummary:{
      total:Number(value?.taskSummary?.total || 0),
      byStatus:safeMetrics(value?.taskSummary?.byStatus),
      byTaskType:safeMetrics(value?.taskSummary?.byTaskType)
    },
    taskEvidence:(Array.isArray(value?.taskEvidence) ? value.taskEvidence : []).slice(0, 60).map((item) => ({
      ref:safeText(item?.ref, 160),
      taskId:safeText(item?.taskId, 128),
      taskType:safeText(item?.taskType, 120),
      assigneeAgentId:safeText(item?.assigneeAgentId, 80) || null,
      status:safeText(item?.status, 60),
      title:safeText(item?.title, 240),
      updatedAt:safeText(item?.updatedAt, 80),
      artifactTypes:safeStringList(item?.artifactTypes, 20, 120)
    }))
  };
}

function architectureEvidenceRefsView(value) {
  return (Array.isArray(value) ? value : []).slice(0, 30).map((item) => ({
    ref:safeText(item?.ref, 500),
    claim:safeText(item?.claim, 1000)
  })).filter((item) => item.ref && item.claim);
}

function architectureFactClaimsView(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((item) => ({
    claim:safeText(item?.claim, 1000),
    evidenceRefs:safeStringList(item?.evidence_refs || item?.evidenceRefs, 10, 500)
  })).filter((item) => item.claim && item.evidenceRefs.length);
}

function architectureJudgmentsView(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((item) => ({
    judgment:safeText(item?.judgment, 1200),
    basisRefs:safeStringList(item?.basis_refs || item?.basisRefs, 10, 500),
    assumptions:safeStringList(item?.assumptions, 10, 600),
    confidence:['low', 'medium', 'high'].includes(item?.confidence) ? item.confidence : 'low'
  })).filter((item) => item.judgment && (item.basisRefs.length || item.assumptions.length));
}

function architectureCandidateProposalsView(value) {
  return (Array.isArray(value) ? value : []).slice(0, 10).map((item) => ({
    proposal:safeText(item?.proposal, 1200),
    problem:safeText(item?.problem, 1000),
    validationPlan:safeText(item?.validation_plan || item?.validationPlan, 1500),
    risks:safeStringList(item?.risks, 10, 600),
    nonGoals:safeStringList(item?.non_goals || item?.nonGoals, 10, 600)
  })).filter((item) => item.proposal && item.problem && item.validationPlan);
}

function findEmployee(agents, value) {
  const key = String(value || '').trim().toLowerCase();
  return agents.find((agent) => String(agent.agentId || '').toLowerCase() === key)
    || agents.find((agent) => String(agent.name || '').toLowerCase() === key)
    || null;
}

function employeeCapabilityView(agent) {
  return {
    agentId:agent.agentId,
    name:agent.name || agent.agentId,
    role:safeText(agent.role, 240),
    acceptedTaskTypes:safeStringList(agent.acceptedTaskTypes, 20, 120)
  };
}

function capabilityView(capability) {
  return {
    id:safeText(capability?.id, 100),
    name:safeText(capability?.name, 120),
    status:safeText(capability?.status, 40),
    detail:safeText(capability?.detail, 500)
  };
}

function taskView(task = {}, approvals = [], detailBaseUrl = '') {
  const taskApprovals = (approvals || []).filter((approval) => (task.approvalRefs || []).includes(approval.approvalId));
  return {
    taskId:task.taskId,
    title:safeText(task.input?.title, 500),
    taskType:safeText(task.taskType, 120),
    agentId:safeText(task.assigneeAgentId || task.routing?.requestedAgentId, 80) || null,
    status:safeText(task.status, 60),
    currentStage:safeText(task.currentStage, 120),
    updatedAt:task.updatedAt || null,
    progress:task.execution?.xiaodProgress ?? null,
    requiresApproval:taskApprovals.some((approval) => approval.status === 'pending'),
    approvals:taskApprovals.map(approvalView),
    error:task.error ? {
      code:safeText(task.error.code, 120),
      category:safeText(task.error.category, 80),
      retryable:task.error.retryable === true,
      userMessage:safeText(task.error.userMessage, 1000)
    } : null,
    artifacts:(task.artifactRefs || []).map(artifactView),
    presentation:presentTask(task, { approvals:taskApprovals, detailBaseUrl })
  };
}

function findMissionTask(overview, response) {
  return (overview.tasks || []).find((task) => task.taskId === response.mission?.taskId) || response.mission;
}

function missionResultMessage(mission, fallback) {
  if (!TERMINAL_STATUSES.has(mission?.status)) return safeText(fallback, 2000);
  const summary = (mission.artifacts || []).find((artifact) => artifact.type === 'cross_agent_mission_summary')?.report;
  if (!summary) return safeText(fallback, 2000);
  const done = (summary.statuses || []).filter((item) => item.status === 'succeeded').length;
  return `总任务已进入终态：${mission.status}，${done}/${summary.statuses?.length || 0} 项分工完成。请根据 mission 和 children 中的已验证产物直接向负责人做最终汇报，不要再返回中间进度。`;
}

function artifactView(artifact = {}) {
  const validation = artifact.validation || {};
  const view = {
    type:safeText(artifact.type, 120),
    ref:safeText(artifact.ref || artifact.url || artifact.location || artifact.data?.larkUrl, 1000) || null,
    verified:artifact.data?.larkPermissionGranted === true
      || artifact.verified === true
      || (validation.exists === true && validation.readable === true && validation.nonEmpty === true)
  };
  if (artifact.type === 'health_report' && artifact.data) {
    view.report = {
      checkedAt:artifact.data.checkedAt || null,
      overall:safeText(artifact.data.overall, 40),
      components:(Array.isArray(artifact.data.components) ? artifact.data.components : []).slice(0, 12).map((item) => ({
        id:safeText(item?.id, 80),
        name:safeText(item?.name, 120),
        status:safeText(item?.status, 40),
        detail:safeText(item?.detail, 500)
      })),
      recommendedAction:safeText(artifact.data.recommendedAction, 500)
    };
  }
  if (artifact.type === 'intel_research_report' && artifact.data) {
    view.report = {
      topic:safeText(artifact.data.topic, 500),
      background:safeText(artifact.data.background, 1200),
      findings:safeStringList(artifact.data.findings, 8, 800),
      conclusion:safeText(artifact.data.conclusion, 1200),
      recommendations:safeStringList(artifact.data.recommendations, 8, 800),
      openQuestions:safeStringList(artifact.data.openQuestions, 8, 800),
      sources:(Array.isArray(artifact.data.sources) ? artifact.data.sources : []).slice(0, 5).map((item) => ({
        title:safeText(item?.title, 300),
        source:safeText(item?.source, 1000),
        summary:safeText(item?.summary, 900)
      }))
    };
  }
  if (artifact.type === 'office_briefing_package' && artifact.data) {
    view.report = {
      title:safeText(artifact.data.title, 500),
      summary:safeText(artifact.data.summary, 1200),
      sourceTasks:(Array.isArray(artifact.data.sourceTasks) ? artifact.data.sourceTasks : []).slice(0, 10).map((item) => ({
        taskId:safeText(item?.taskId, 100),
        title:safeText(item?.title, 500),
        employeeId:safeText(item?.employeeId, 80) || null,
        status:safeText(item?.status, 60)
      })),
      openItems:safeStringList(artifact.data.openItems, 8, 600),
      nextAction:safeText(artifact.data.nextAction, 800)
    };
  }
  if (artifact.type === 'autonomous_work_plan' && artifact.data?.plan) {
    const plan = artifact.data.plan;
    view.report = {
      status:safeText(plan.status, 60),
      version:Number.isSafeInteger(plan.version) ? plan.version : null,
      steps:(Array.isArray(plan.steps) ? plan.steps : []).slice(0, 20).map((step) => ({
        stepId:safeText(step?.stepId, 128),
        objective:safeText(step?.objective, 500),
        status:safeText(step?.status, 60),
        dependsOn:safeStringList(step?.dependsOn, 20, 128)
      })),
      budget:{
        maxDurationMs:Number(plan.budget?.hardLimits?.maxDurationMs) || null,
        maxModelCalls:Number(plan.budget?.hardLimits?.maxModelCalls) || null,
        maxConcurrency:Number(plan.budget?.hardLimits?.maxConcurrency) || null,
        maxDelegationDepth:Number(plan.budget?.hardLimits?.maxDelegationDepth) || null,
        approvalThresholdUsd:Number(plan.budget?.approvalThresholdUsd) || 0
      }
    };
  }
  if (artifact.type === 'capability_discovery_report' && artifact.data) {
    view.report = {
      requestedCount:Number(artifact.data.requestedCount) || 0,
      activeCount:Number(artifact.data.activeCount) || 0,
      results:(Array.isArray(artifact.data.results) ? artifact.data.results : []).slice(0, 20).map((item) => ({
        capabilityId:safeText(item?.capabilityId, 120),
        status:safeText(item?.status, 60),
        reason:safeText(item?.reason, 500)
      }))
    };
  }
  if (artifact.type === 'cross_agent_mission_summary' && artifact.data) {
    view.report = {
      kind:safeText(artifact.data.kind, 60),
      summary:safeText(artifact.data.summary, 1000),
      completed:artifact.data.completed === true,
      terminal:artifact.data.terminal === true,
      statuses:(Array.isArray(artifact.data.statuses) ? artifact.data.statuses : []).slice(0, 11).map((item) => ({
        title:safeText(item?.title, 500),
        employeeId:safeText(item?.employeeId, 80) || null,
        taskId:safeText(item?.taskId, 100) || null,
        status:safeText(item?.status, 60),
        artifactTypes:safeStringList(item?.artifactTypes, 10, 120)
      })),
      outcome:safeText(artifact.data.decision?.outcome, 60),
      briefing:artifact.data.decision?.briefing ? {
        title:safeText(artifact.data.decision.briefing.title, 500),
        summary:safeText(artifact.data.decision.briefing.summary, 1000),
        openItems:safeStringList(artifact.data.decision.briefing.openItems, 5, 500),
        nextAction:safeText(artifact.data.decision.briefing.nextAction, 500)
      } : null
    };
  }
  return view;
}

function approvalView(approval = {}) {
  return {
    approvalId:approval.approvalId,
    taskId:approval.taskId || null,
    status:safeText(approval.status, 40),
    governanceMode:safeText(approval.governanceMode, 40),
    action:safeText(approval.action, 100),
    riskLevel:safeText(approval.riskLevel, 40),
    reason:safeText(approval.reason, 700),
    requestedScope:approval.requestedScope ? {
      title:safeText(approval.requestedScope.title, 500),
      taskType:safeText(approval.requestedScope.taskType, 120),
      assigneeAgentId:safeText(approval.requestedScope.assigneeAgentId, 80) || null
    } : null,
    validUntil:approval.validUntil || null,
    privateReadGrantStatus:approval.privateReadGrantStatus ? {
      status:safeText(approval.privateReadGrantStatus.status, 40),
      remainingUses:Number(approval.privateReadGrantStatus.remainingUses) || 0,
      expiresAt:approval.privateReadGrantStatus.expiresAt || null
    } : null
  };
}

function safeChannel(channel) {
  if (!channel) return null;
  return { status:safeText(channel.status, 40), message:safeText(channel.message, 300), verified:channel.verified === true };
}

function safeText(value, limit = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeStringList(value, maxItems, maxChars) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => safeText(item, maxChars)).filter(Boolean))].slice(0, maxItems);
}

function normalizeStatuses(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((item) => safeText(item, 60)).filter(Boolean))];
}

function requiredId(value, message) {
  const id = String(value || '').trim();
  if (!/^[0-9a-z-]{8,100}$/i.test(id)) throw new AgentArmyClientError(message);
  return id;
}

function optionalConnectionId(value) {
  const id = safeText(value, 100);
  if (!id) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new AgentArmyClientError('账号连接标识格式不正确。');
  }
  return id;
}

function shortHash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }
function boundedLimit(value) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 10; }
function boundedDuration(value, min, max, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback; }
function newestFirst(left, right) { return String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')); }

function normalizeMissionItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 11) return [];
  const items = value.map((item, index) => ({
    key:safeText(item?.key, 80) || `work-${index + 1}`,
    title:safeText(item?.title, 500),
    taskType:safeText(item?.taskType, 120),
    agentId:safeText(item?.agentId, 80),
    description:safeText(item?.description, 2000),
    acceptance:safeText(item?.acceptance, 500),
    sourceUrls:safeStringList(item?.sourceUrls, 5, 2000),
    connectionId:optionalConnectionId(item?.connectionId),
    reviewPolicy:item?.reviewPolicy === 'required' ? 'required' : 'optional',
    evidenceMode:item?.evidenceMode === 'preliminary' ? 'preliminary' : 'formal',
    depth:item?.depth === 'full' ? 'full' : 'fast',
    visualMode:normalizeVisualMode(item?.visualMode),
    focus:safeText(item?.focus, 500),
    platforms:safeStringList(item?.platforms, 3, 40),
    contentGoal:safeText(item?.contentGoal, 500),
    dependsOnPrevious:item?.dependsOnPrevious === true,
    dependsOn:safeStringList(item?.dependsOn, 10, 80)
  }));
  const keys = new Set(items.map((item) => item.key));
  const valid = items.every((item, index) => (
    item.title
    && item.taskType
    && item.agentId
    && item.dependsOn.every((key) => keys.has(key) && key !== item.key)
  ));
  return valid ? items : [];
}

function normalizeGoalSpecInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = safeText(value.outcome || value.goal, 1000);
  if (!outcome) return null;
  const budget = value.budget && typeof value.budget === 'object' && !Array.isArray(value.budget)
    ? {
        maxDurationMinutes:boundedDuration(value.budget.maxDurationMinutes, 1, 60, 60),
        maxModelCalls:boundedDuration(value.budget.maxModelCalls, 1, 20, 20),
        maxConcurrentSubtasks:boundedDuration(value.budget.maxConcurrentSubtasks, 1, 4, 4),
        maxDependencyDepth:boundedDuration(value.budget.maxDependencyDepth, 1, 2, 2),
        maxCostUsd:Number.isFinite(Number(value.budget.maxCostUsd))
          ? Math.max(0, Math.min(5, Number(value.budget.maxCostUsd)))
          : 5
      }
    : undefined;
  return {
    outcome,
    deliverables:safeStringList(value.deliverables, 12, 500),
    constraints:safeStringList(value.constraints, 20, 500),
    acceptanceCriteria:safeStringList(value.acceptanceCriteria, 20, 500),
    capabilityRequests:(Array.isArray(value.capabilityRequests) ? value.capabilityRequests : []).slice(0, 12).map((request) => ({
      capabilityId:safeText(request?.capabilityId, 120),
      purpose:safeText(request?.purpose, 500),
      source:safeText(request?.source, 500) || 'registered-catalog'
    })).filter((request) => request.capabilityId && request.purpose),
    ...(budget ? { budget } : {})
  };
}
