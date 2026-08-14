import {
  agentArmyApprovalView as approvalView,
  agentArmyTaskView as taskView,
} from './agent-army-client-task-view.js';
import { armyStatusReadView, capabilitiesReadView, capabilityTruthView } from './agent-army-read-views.ts';
import {
  AgentArmyTaskInputError,
  prepareMissionCreateRequest,
  prepareTaskCreateRequest,
} from './contracts/agent-army-task-input.js';
import { taskDetailBaseUrl } from './task-presentation.js';
import { dynamicCardAnchorAcknowledged, normalizeCompletionDelivery } from './source-completion-watch.ts';
import { isTaskNotificationTerminalStatus } from './task-status-policy.ts';

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
    return capabilitiesReadView(await this.overview());
  }

  async armyStatus() {
    return armyStatusReadView(await this.overview());
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
      capabilityTruth:capabilityTruthView(agent.capabilityTruth),
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

  async getTask(taskId, { chatRef = '', agentId = '', profileId = '' } = {}) {
    const id = requiredId(taskId, '任务编号无效。');
    const overview = await this.overview();
    const task = (overview.tasks || []).find((item) => item.taskId === id);
    if (!task) throw new AgentArmyClientError('没有找到这条任务。');
    let notification = null;
    try {
      notification = await this.request('/api/feishu/task-status', {
        method: 'POST',
        body: {
          taskId:id,
          chatId:safeText(chatRef, 240),
          agentId:safeText(agentId, 80),
          profileId:safeText(profileId, 80),
        }
      });
    } catch (error) {
      const message = String(error?.message || '');
      const unavailableWithoutFeishuContext = [
        '当前会话不能读取',
        '只能读取或操作由飞书创建的任务卡',
        '任务卡缺少原飞书会话',
      ].some((fragment) => message.includes(fragment));
      if (chatRef || !unavailableWithoutFeishuContext) throw error;
    }
    return {
      ...taskView(task, overview.approvals || [], this.detailBaseUrl),
      terminal: notification?.terminal ?? isTaskNotificationTerminalStatus(task.status),
      userMessage: safeText(notification?.message || task.error?.userMessage || '', 2000),
      ...(notification?.taskCard ? { taskCard:notification.taskCard } : {}),
    };
  }

  async createTask(input = {}) {
    const prepared = taskInputContract(() => prepareTaskCreateRequest(input, { now:this.now }));
    if (prepared.kind === 'mission') return this.createMission(prepared.missionInput);
    const response = await this.request('/api/tasks', {
      method:'POST',
      body:prepared.body,
    });
    const completionWatch = await this.ensureCompletionWatch(
      response.completionWatch,
      response.task?.taskId,
      prepared.chatRef,
      prepared.completionDelivery,
    );
    return {
      ...(await this.getTask(response.task?.taskId, {
        chatRef:prepared.chatRef,
        agentId:prepared.sourceAgentId,
        profileId:prepared.sourceProfileId,
      })),
      completionWatch,
      ...(prepared.completionDelivery ? { completionDelivery:prepared.completionDelivery } : {}),
    };
  }

  async createMission(input = {}) {
    const prepared = taskInputContract(() => prepareMissionCreateRequest(input, { now:this.now }));
    const response = await this.request('/api/mcp/missions', {
      method:'POST',
      body:prepared.body,
    });
    const completionWatch = await this.ensureCompletionWatch(
      response.completionWatch,
      response.mission?.taskId,
      prepared.chatRef,
      prepared.completionDelivery,
    );
    let overview = await this.overview();
    let missionTask = findMissionTask(overview, response);
    if (input.waitForTerminal === true && missionTask && !isTaskNotificationTerminalStatus(missionTask.status)) {
      const maxPolls = Math.ceil(this.missionWaitMs / this.missionPollMs);
      for (let poll = 0; poll < maxPolls && !isTaskNotificationTerminalStatus(missionTask.status); poll += 1) {
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
      completionWatch,
      ...(prepared.completionDelivery ? { completionDelivery:prepared.completionDelivery } : {}),
      userMessage:completionWatchMessage(missionResultMessage(missionView, response.reply), completionWatch)
    };
  }

  async ensureCompletionWatch(serverResult, taskId, chatRef, completionDelivery = null) {
    const delivery = normalizeCompletionDelivery(completionDelivery || serverResult?.completionDelivery);
    if (delivery && dynamicCardAnchorAcknowledged(serverResult?.completionDelivery)) {
      return {
        required:false,
        registered:false,
        delegated:true,
        duplicateWatchSuppressed:serverResult?.registered !== true,
        taskId:safeText(taskId, 100),
        completionDelivery:delivery,
      };
    }
    if (serverResult?.registered === true || (serverResult?.required === false && !delivery)) return serverResult;
    return this.registerCompletionWatch(taskId, chatRef);
  }

  async registerCompletionWatch(taskId, chatRef) {
    const task = safeText(taskId, 100);
    const chat = safeText(chatRef, 240);
    if (!task || !chat) return { required:false, registered:false };
    try {
      return { required:true, ...(await this.request('/api/mcp/completion-watches', {
        method:'POST',
        body:{ taskId:task, chatRef:chat }
      })) };
    } catch {
      // 任务已成功创建时，通知登记暂时失败不能篡改任务事实。
      // 用户仍可通过 task_get 查询；运行台恢复后下一次请求会幂等补登记。
      return { required:true, registered:false, taskId:task, errorCode:'completion_watch_registration_failed' };
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

  async recordTaskFeedback(taskId, { sentiment, note = '', chatRef = '' } = {}) {
    const id = requiredId(taskId, '任务编号无效。');
    const normalized = String(sentiment || '').trim().toLowerCase();
    if (!['useful', 'needs_improvement'].includes(normalized)) {
      throw new AgentArmyClientError('任务评价只支持 useful 或 needs_improvement。');
    }
    const response = await this.request(`/api/mcp/tasks/${encodeURIComponent(id)}/feedback`, {
      method:'POST',
      body:{
        sentiment:normalized,
        note:safeText(note, 1000),
        chatRef:safeText(chatRef, 240),
      },
    });
    const overview = await this.overview();
    return taskView(response.task, overview.approvals || [], this.detailBaseUrl);
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

  async revokePrivateReadGrant(approvalId, { chatRef } = {}) {
    const id = requiredId(approvalId, '审批编号无效。');
    const boundChatRef = safeText(chatRef, 240);
    if (!boundChatRef) throw new AgentArmyClientError('从飞书撤销微信临时授权时必须带原会话标识。');
    const response = await this.request(`/api/feishu/approvals/${encodeURIComponent(id)}/revoke-private-read-grant`, {
      method:'POST',
      body:{ chatRef:boundChatRef, requesterRef:'A君当前飞书会话' },
    });
    return { approval:approvalView(response.approval || { approvalId:id }) };
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
        ...(response.assignment?.contextCapsule
          ? { contextCapsule:taskContextCapsuleView(response.assignment.contextCapsule) }
          : {}),
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

  async recordPaperclipLocalAiRunEvent(input = {}) {
    const event = input.event && typeof input.event === 'object' && !Array.isArray(input.event)
      ? input.event
      : {};
    return this.request('/api/mcp/local-ai-run-event', {
      method:'POST',
      body:{
        ...paperclipAssignmentIdentity(input),
        taskId:safeText(input.taskId, 128),
        event:Object.fromEntries(Object.entries({
          eventType:safeText(event.eventType, 120),
          capabilityId:safeText(event.capabilityId, 160),
          provider:safeText(event.provider, 120),
          status:safeText(event.status, 80),
          startedAt:safeText(event.startedAt, 80),
          finishedAt:safeText(event.finishedAt, 80),
          durationMs:Number.isSafeInteger(event.durationMs) && event.durationMs >= 0
            ? event.durationMs
            : undefined,
          receiptId:safeText(event.receiptId, 160),
          spanId:safeText(event.spanId, 120),
          errorCode:safeText(event.errorCode, 120),
        }).filter(([, value]) => value !== undefined && value !== '')),
      },
      paperclipApiKey:process.env.PAPERCLIP_API_KEY,
    });
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
        qualityReview:qualityReviewView(input.qualityReview),
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

function taskContextCapsuleView(value = {}) {
  return {
    schemaVersion:'agent.army/task-context-capsule/v1',
    taskId:safeText(value.taskId, 128),
    taskType:safeText(value.taskType, 120),
    status:safeText(value.status, 60),
    goal:safeText(value.goal, 300),
    result:safeText(value.result, 500),
    adoptedArtifactRefs:(Array.isArray(value.adoptedArtifactRefs) ? value.adoptedArtifactRefs : []).slice(0, 10).map((item) => ({
      artifactId:safeText(item?.artifactId, 160) || null,
      type:safeText(item?.type, 120) || null,
      title:safeText(item?.title, 200) || null,
      checksum:safeText(item?.checksum, 160) || null,
      location:safeText(item?.location, 500) || null,
    })),
    keyDecisions:safeStringList(value.keyDecisions, 5, 300),
    unfinishedItems:safeStringList(value.unfinishedItems, 5, 300),
    nextAction:safeText(value.nextAction, 300),
    evidenceRefs:safeStringList(value.evidenceRefs, 10, 240),
    updatedAt:safeText(value.updatedAt, 80) || null,
  };
}

export class AgentArmyClientError extends Error {}

function taskInputContract(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AgentArmyTaskInputError) throw new AgentArmyClientError(error.message);
    throw error;
  }
}

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
      toolAllowlist:safeStringList(item?.toolAllowlist, 20, 160),
      repositoryRefs:safeStringList(item?.repositoryRefs, 6, 500)
    })),
    taskTypes:(Array.isArray(value?.taskTypes) ? value.taskTypes : []).slice(0, 50).map((item) => ({
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
    taskEvidence:(Array.isArray(value?.taskEvidence) ? value.taskEvidence : []).slice(0, 24).map((item) => ({
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

function qualityReviewView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const status = safeText(value.status, 40);
  if (!['passed', 'revise', 'blocked'].includes(status)) return undefined;
  return {
    status,
    failedCriteria:safeStringList(value.failedCriteria, 100, 100),
    evidenceRefs:safeStringList(value.evidenceRefs, 100, 240),
    safeSummary:safeText(value.safeSummary, 1000) || null,
  };
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

function findMissionTask(overview, response) {
  return (overview.tasks || []).find((task) => task.taskId === response.mission?.taskId) || response.mission;
}

function missionResultMessage(mission, fallback) {
  if (!isTaskNotificationTerminalStatus(mission?.status)) return safeText(fallback, 2000);
  const summary = (mission.artifacts || []).find((artifact) => artifact.type === 'cross_agent_mission_summary')?.report;
  if (!summary) return safeText(fallback, 2000);
  const done = (summary.statuses || []).filter((item) => item.status === 'succeeded').length;
  return `总任务已进入终态：${mission.status}，${done}/${summary.statuses?.length || 0} 项分工完成。请根据 mission 和 children 中的已验证产物直接向负责人做最终汇报，不要再返回中间进度。`;
}

function completionWatchMessage(message, watch) {
  const base = safeText(message, 2000);
  if (watch?.required === true && watch?.registered !== true) {
    return `${base}\n\n自动回告暂未登记成功；任务本身已建立，请保留任务编号并主动查询进度。`;
  }
  return base;
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

function boundedLimit(value) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 10; }
function boundedDuration(value, min, max, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback; }
function newestFirst(left, right) { return String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')); }
