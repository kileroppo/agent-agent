import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentArmyClient, AgentArmyClientError } from './agent-army-client.js';
import { canonicalizeBusinessAssignment } from './business-task-routing.ts';
import { formatTaskPresentation } from './task-presentation.js';
import { LocalAiCapabilityClient } from './local-ai-capability-client.js';
import { AgentRegistry } from './agent-registry.js';
import { AgentManualService } from './agent-manual-service.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function createAgentArmyMcpServer({
  client = new AgentArmyClient(),
  localAi = new LocalAiCapabilityClient(),
  manuals = new AgentManualService({ registry:new AgentRegistry({ agentsDir:path.join(repositoryRoot, 'agents') }) }),
  scope = scopeFromEnvironment()
} = {}) {
  const server = new McpServer({
    name:'agent-army',
    version:'0.1.0'
  });
  const read = (name, config, handler) => {
    if (toolAllowed(name, scope)) readTool(server, name, config, handler);
  };
  const action = (name, config, handler) => {
    if (toolAllowed(name, scope)) actionTool(server, name, config, handler);
  };

  read('capabilities', {
    title:'Agent军团能力真相',
    description:'列出岗位登记、可接受任务类型，以及能力从已声明到真实任务验证的分层状态。回答“你能做什么”“谁能做这件事”前先调用；不得把已登记或在线冒充已验证。',
    inputSchema:z.object({})
  }, async () => scopedCapabilities(await client.capabilities(), scope));

  read('agent_manual', {
    title:'Agent使用说明书',
    description:'用户问“这个 Agent 是什么、怎么用、输入输出、用了什么工具、注意事项、说明书”时必须调用。A君可按名称查询任一已上岗 Agent，传 all 可返回全部说明书；其他 Agent 只能查询自己的说明书。这是只读查询，禁止为说明书问题创建任务。',
    inputSchema:z.object({
      agent:z.string().min(1).max(80).optional().describe('Agent 名称、agentId，或 all。当前 Agent 查询自己时可省略。')
    })
  }, ({ agent }) => manuals.get({ agent, requesterAgentIds:scope.agentIds }));

  read('status', {
    title:'Agent军团总览',
    description:'读取员工、任务焦点、今日使用和公共能力的当前真实状态。用于“大家在干嘛”“军团是否正常”；不会创建任务。',
    inputSchema:z.object({})
  }, () => client.armyStatus());

  read('employee_status', {
    title:'员工状态',
    description:'按员工名称或 agentId 读取岗位边界和最近真实任务。用于“小D在干嘛”等问题；不会创建任务。',
    inputSchema:z.object({
      employee:z.string().min(1).max(80).describe('员工显示名或 agentId，例如 小D、operator、架构师')
    })
  }, ({ employee }) => client.employeeStatus(employee));

  read('task_list', {
    title:'任务列表',
    description:'读取最近任务，可按状态和员工筛选。只返回脱敏任务摘要；不会创建或改变任务。',
    inputSchema:z.object({
      status:z.union([z.string(), z.array(z.string())]).optional().describe('可选状态，例如 running 或 running,waiting_approval'),
      employee:z.string().max(80).optional().describe('可选员工名称或 agentId'),
      limit:z.number().int().min(1).max(50).optional().default(10)
    })
  }, (input) => client.listTasks(scopedTaskFilter(input, scope)));

  read('task_get', {
    title:'读取任务',
    description:'按任务编号读取真实阶段、审批、失败和已验证产物。用户追问“刚才那个任务”时优先使用会话中已经出现的任务编号。',
    inputSchema:z.object({
      task_id:z.string().min(8).max(100),
      chat_ref:z.string().max(240).optional().describe('当前 Hermes 会话上下文中可见的原飞书 chat id；没有时省略')
    })
  }, async ({ task_id, chat_ref }) => {
    const task = await client.getTask(task_id, { chatRef:chat_ref });
    assertReadableTask(task, scope);
    return task;
  });

  action('task_create', {
    title:'创建军团任务',
    description:'把用户明确要求执行的工作交给已上岗员工。状态查询、能力询问、闲聊和仅讨论方案时禁止调用。先用 capabilities 确认 task_type 和员工；高风险工作只会进入审批，不会绕过审批执行。',
    inputSchema:z.object({
      title:z.string().min(1).max(500).describe('用户要得到的可验证结果'),
      task_type:z.string().min(1).max(120).describe('必须来自 capabilities 返回的 acceptedTaskTypes'),
      agent_id:z.string().max(80).optional().describe('仅在需要点名且 capabilities 已确认支持时提供'),
      description:z.string().max(2000).optional(),
      source_urls:z.array(z.string().url()).max(5).optional(),
      connection_id:z.string().uuid().optional().describe('可选；仅在需要覆盖平台默认账号时传入 A君 返回的连接编号'),
      source_task_ids:z.array(z.string().min(8).max(100)).max(20).optional().describe('需要引用的既有任务编号；可拍脚本未提供时会自动匹配参考案例'),
      review_policy:z.enum(['optional', 'required']).optional().describe('默认 optional：质量合格时系统自动确认，异常时转人工；只有用户明确要求完整听审时使用 required'),
      evidence_mode:z.enum(['preliminary', 'formal']).optional(),
      analysis_intent:z.enum(['digest', 'deep', 'template', 'style']).optional().describe('视频分析模式：精华提炼、深度拆解、模板学习或风格探索'),
      depth:z.enum(['fast', 'full']).optional(),
      visual_mode:z.enum(['auto', 'off', 'required']).optional().describe('默认 auto：快速模式最多 12 帧，完整模式最多 48 帧；off 只分析文字；required 缺少画面时要求补充素材'),
      focus:z.string().max(500).optional(),
      platforms:z.array(z.string().min(1).max(40)).max(10).optional(),
      content_goal:z.string().max(500).optional(),
      duration_seconds:z.number().min(15).max(600).optional(),
      research_mode:z.enum(['auto', 'off']).optional(),
      approved_for_use:z.boolean().optional().describe('仅当用户明确回复“用这版”时为 true'),
      source_script_task_id:z.string().min(8).max(100).optional(),
      metrics:z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      goal:z.string().min(1).max(1000).optional().describe('开放型或复杂任务的最终结果；提供后系统会建立可审计的自主工作计划'),
      deliverables:z.array(z.string().min(1).max(500)).max(12).optional(),
      constraints:z.array(z.string().min(1).max(500)).max(20).optional(),
      acceptance_criteria:z.array(z.string().min(1).max(500)).max(20).optional(),
      capability_requests:z.array(z.object({
        capability_id:z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).max(120),
        purpose:z.string().min(1).max(500),
        source:z.string().max(500).optional()
      })).max(12).optional().describe('只申请完成目标必需的能力；凭据、外发、扩权和高成本能力仍会停在审批'),
      autonomy_budget:z.object({
        max_duration_minutes:z.number().int().min(1).max(60).optional(),
        max_model_calls:z.number().int().min(1).max(20).optional(),
        max_concurrent_subtasks:z.number().int().min(1).max(4).optional(),
        max_dependency_depth:z.number().int().min(1).max(2).optional(),
        max_cost_usd:z.number().min(0).max(5).optional()
      }).optional(),
      chat_ref:z.string().max(240).optional().describe('当前 Hermes 会话上下文中可见的原飞书 chat id；用于任务归属和恢复'),
      request_ref:z.string().max(240).optional().describe('当前消息或稳定请求引用；有则用于严格幂等')
    })
  }, ({ title, task_type, agent_id, description, source_urls, connection_id, source_task_ids, review_policy, evidence_mode, analysis_intent, depth, visual_mode, focus, platforms, content_goal, duration_seconds, research_mode, approved_for_use, source_script_task_id, metrics, goal, deliverables, constraints, acceptance_criteria, capability_requests, autonomy_budget, chat_ref, request_ref }) => {
    assertSingleTaskRequest({ title, description });
    const assignment = canonicalizeBusinessAssignment({
      title,
      taskType:task_type,
      agentId:agent_id,
      description,
      dependsOnPrevious:Array.isArray(source_task_ids) && source_task_ids.length > 0
    });
    assertTaskScope(assignment, scope);
    return client.createTask({
      title:assignment.title,
      taskType:assignment.taskType,
      agentId:assignment.agentId || onlyValue(scope.agentIds),
      description:assignment.description,
      sourceUrls:source_urls,
      connectionId:connection_id,
      sourceTaskIds:source_task_ids,
      reviewPolicy:review_policy,
      evidenceMode:evidence_mode,
      analysisIntent:analysis_intent,
      depth,
      visualMode:visual_mode,
      focus,
      platforms,
      contentGoal:content_goal,
      durationSeconds:duration_seconds,
      researchMode:research_mode,
      approvedForUse:approved_for_use,
      sourceScriptTaskId:source_script_task_id,
      metrics,
      goalSpec:goal ? {
        outcome:goal,
        deliverables,
        constraints,
        acceptanceCriteria:acceptance_criteria,
        capabilityRequests:(capability_requests || []).map((request) => ({
          capabilityId:request.capability_id,
          purpose:request.purpose,
          source:request.source
        })),
        budget:autonomy_budget ? {
          maxDurationMinutes:autonomy_budget.max_duration_minutes,
          maxModelCalls:autonomy_budget.max_model_calls,
          maxConcurrentSubtasks:autonomy_budget.max_concurrent_subtasks,
          maxDependencyDepth:autonomy_budget.max_dependency_depth,
          maxCostUsd:autonomy_budget.max_cost_usd
        } : undefined
      } : undefined,
      chatRef:chat_ref,
      requestRef:request_ref
    });
  });

  action('mission_create', {
    title:'创建老板多人任务',
    description:'当用户一次明确交办多项可并行或存在依赖的工作时，建立一个总任务并分派给最多 11 名已上岗员工。系统按显式依赖图推进且同时运行不超过 4 项；单项工作仍用 task_create。',
    inputSchema:z.object({
      title:z.string().min(1).max(500).describe('整组工作的总目标'),
      items:z.array(z.object({
        key:z.string().min(1).max(80).optional(),
        title:z.string().min(1).max(500),
        task_type:z.string().min(1).max(120).describe('必须来自 capabilities'),
        agent_id:z.string().min(1).max(80).describe('必须是支持该 task_type 的已上岗员工'),
        description:z.string().max(2000).optional(),
        acceptance:z.string().max(500).optional(),
        source_urls:z.array(z.string().url()).max(5).optional(),
        review_policy:z.enum(['optional', 'required']).optional().describe('默认自动质量确认；用户明确要求人工完整听审时传 required'),
        evidence_mode:z.enum(['preliminary', 'formal']).optional(),
        analysis_intent:z.enum(['digest', 'deep', 'template', 'style']).optional(),
        depth:z.enum(['fast', 'full']).optional(),
        visual_mode:z.enum(['auto', 'off', 'required']).optional(),
        focus:z.string().max(500).optional(),
        platforms:z.array(z.string().min(1).max(40)).max(3).optional(),
        content_goal:z.string().max(500).optional(),
        depends_on_previous:z.boolean().optional().describe('兼容字段：等待列表中所有前置分工结束或明确卡点'),
        depends_on:z.array(z.string().min(1).max(80)).max(10).optional().describe('当前分工依赖的 item key，可表达非线性的依赖关系')
      })).min(1).max(11),
      chat_ref:z.string().max(240).optional(),
      request_ref:z.string().max(240).optional()
    })
  }, ({ title, items, chat_ref, request_ref }) => {
    if (!scope.allowMissions) throw new AgentArmyClientError('当前员工身份不能创建多人总任务；请交给 A君。');
    const assignments = items.map((item) => ({
      key:item.key,
      title:item.title,
      taskType:item.task_type,
      agentId:item.agent_id,
      description:item.description,
        acceptance:item.acceptance,
        sourceUrls:item.source_urls,
        reviewPolicy:item.review_policy,
        evidenceMode:item.evidence_mode,
        analysisIntent:item.analysis_intent,
        depth:item.depth,
        visualMode:item.visual_mode,
        focus:item.focus,
        platforms:item.platforms,
        contentGoal:item.content_goal,
        dependsOnPrevious:item.depends_on_previous === true,
        dependsOn:item.depends_on
    })).map((item, index) => canonicalizeBusinessAssignment(item, { index }));
    for (const item of assignments) assertTaskScope(item, scope);
    return client.createMission({
      title,
      items:assignments,
      chatRef:chat_ref,
      requestRef:request_ref,
      waitForTerminal:true
    });
  });

  action('task_control', {
    title:'暂停或继续任务',
    description:'请求暂停或继续一条支持控制的真实任务。该调用只创建/返回审批，不会绕过 Paperclip；随后使用 approval_resolve 由用户确认。',
    inputSchema:z.object({
      task_id:z.string().min(8).max(100),
      action:z.enum(['pause', 'resume'])
    })
  }, ({ task_id, action }) => client.controlTask(task_id, action));

  action('task_feedback', {
    title:'记录任务结果评价',
    description:'负责人对刚完成的任务明确表示“有用、验收通过”或“需要改进”时必须调用。先用 task_get 核对任务编号；只能在原飞书会话写回评价，不会创建任务或执行外部动作。',
    inputSchema:z.object({
      task_id:z.string().min(8).max(100),
      sentiment:z.enum(['useful', 'needs_improvement']),
      note:z.string().max(1000).optional(),
      chat_ref:z.string().min(1).max(240).describe('当前 Hermes 会话可见的原飞书 chat id，必须与任务来源一致'),
    }),
  }, ({ task_id, sentiment, note, chat_ref }) => client.recordTaskFeedback(task_id, {
    sentiment,
    note,
    chatRef:chat_ref,
  }));

  if (scope.allowedTools?.includes('local_ai_invoke') && scope.localAiCapabilities?.length) action('local_ai_invoke', {
    title:'调用岗位获准的本机 AI 能力',
    description:'按能力名调用 A君统一管理的本机模型。服务未运行时由控制网关按需唤醒；只能使用当前岗位 Manifest 已授权的能力。不得猜测文件路径，不得自行跨设备或绕过审批。',
    inputSchema:z.object({
      capability:z.string().min(1).max(80).describe('必须是当前岗位获准的本机能力名'),
      input:z.record(z.unknown()).describe('能力输入；文件路径必须来自当前真实指派或已验证产物'),
      options:z.record(z.unknown()).optional().default({}),
      request_id:z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
    }),
  }, ({ capability, input, options, request_id }) => {
    if (!scope.localAiCapabilities.includes(capability)) {
      throw new AgentArmyClientError(`当前岗位没有本机 AI 能力 ${capability}。`);
    }
    const safeOptions = { ...options, preferredNode:'mac' };
    delete safeOptions.allowDesktopFallback;
    return localAi.invoke({
      capability,
      input,
      options:safeOptions,
      requestId:request_id,
      approved:false,
    });
  });

  read('approval_list', {
    title:'审批列表',
    description:'读取待处理或历史审批的脱敏摘要。不会自动批准。',
    inputSchema:z.object({
      status:z.enum(['pending', 'approved', 'rejected', 'expired', 'all']).optional().default('pending'),
      limit:z.number().int().min(1).max(50).optional().default(10)
    })
  }, (input) => client.listApprovals(input));

  if (toolAllowed('approval_resolve', scope)) server.registerTool('approval_resolve', {
    title:'处理军团审批',
    description:'批准或拒绝一条明确审批。批准会通过 Hermes 当前会话再次向真人确认；明确拒绝直接安全关闭。批准未确认、超时或会话离开时一律不执行。',
    inputSchema:z.object({
      approval_id:z.string().min(8).max(100),
      decision:z.enum(['approve', 'reject'])
    }),
    annotations:{ readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false }
  }, async ({ approval_id, decision }, extra) => toolResult(async () => {
    const pending = (await client.listApprovals({ status:'pending', limit:50 })).find((approval) => approval.approvalId === approval_id);
    if (!pending) throw new AgentArmyClientError('这条审批不存在、已处理或已过期。');
    if (decision === 'reject') return client.resolveApproval(approval_id, decision);
    const verb = '批准并按该范围继续';
    const consent = await server.server.elicitInput({
      mode:'form',
      message:`请确认是否${verb}：${pending.reason || pending.requestedScope?.title || pending.approvalId}`,
      requestedSchema:{
        type:'object',
        properties:{
          confirm:{ type:'boolean', title:'确认本次决定', description:`勾选后${verb}` }
        }
      }
    }, { relatedRequestId:extra.requestId, timeout:300_000 });
    // Hermes currently reports an accepted elicitation with an empty content
    // object. The action is the authoritative consent signal; an explicit
    // false value still wins for clients that return the optional field.
    if (consent.action !== 'accept' || consent.content?.confirm === false) {
      throw new AgentArmyClientError('真人没有确认，本次审批未执行。');
    }
    return client.resolveApproval(approval_id, decision);
  }));

  action('private_read_grant_revoke', {
    title:'撤销微信临时读取授权',
    description:'立即撤销一条仍有效的微信临时读取授权。只能从创建该任务的原飞书会话调用；这是收紧权限，不会读取微信或创建新授权。',
    inputSchema:z.object({
      approval_id:z.string().min(8).max(100),
      chat_ref:z.string().min(1).max(240).describe('当前 Hermes 会话可见的原飞书 chat id，必须与任务来源一致')
    })
  }, ({ approval_id, chat_ref }) => client.revokePrivateReadGrant(approval_id, { chatRef:chat_ref }));

  read('paperclip_assignment_get', {
    title:'读取当前 Paperclip 指派',
    description:'每次 Paperclip heartbeat 只调用一次。读取当前运行的真实指派，并在 A君任务账本建立或关联同一任务信封；返回内容已经足够完成任务，不要重复读取。普通飞书会话没有运行身份时禁止调用。',
    inputSchema:z.object({})
  }, () => client.getPaperclipAssignment(paperclipIdentityFromEnvironment()));

  action('agent_proposal_create_execute', {
    title:'创建并提交当前岗位草案',
    description:'仅供创建官在 Paperclip heartbeat 中使用。把当前自然语言岗位需求写成结构化 AgentProposal 并提交审核；只允许已登记能力，敏感能力会停在待建设/待专项审批，不会自动安装、试用或激活。',
    inputSchema:z.object({
      requested_outcome:z.string().min(1).max(500),
      candidate_name:z.string().min(1).max(120),
      agent_id:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
      department:z.string().min(1).max(120),
      responsibilities:z.array(z.string().min(1).max(500)).min(1).max(8),
      non_responsibilities:z.array(z.string().min(1).max(500)).min(1).max(10),
      accepted_task_types:z.array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).max(120)).min(1).max(8),
      desired_skills:z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120)).max(8).optional(),
      requested_capabilities:z.array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).max(120)).max(8).optional(),
      acceptance_title:z.string().min(1).max(500)
    })
  }, ({
    requested_outcome,
    candidate_name,
    agent_id,
    department,
    responsibilities,
    non_responsibilities,
    accepted_task_types,
    desired_skills,
    requested_capabilities,
    acceptance_title
  }) => client.executeAgentProposal({
    ...paperclipIdentityFromEnvironment(),
    requestedOutcome:requested_outcome,
    candidateName:candidate_name,
    agentId:agent_id,
    department,
    responsibilities,
    nonResponsibilities:non_responsibilities,
    acceptedTaskTypes:accepted_task_types,
    desiredSkills:desired_skills,
    requestedCapabilities:requested_capabilities,
    acceptanceTitle:acceptance_title
  }));

  action('paperclip_assignment_complete', {
    title:'回报当前 Paperclip 指派结果',
    description:'仅在 Paperclip heartbeat 中把当前指派的真实结果回写到同一张 Paperclip 任务和 A君任务信封。不得用它关闭别人的任务；失败或待测试必须如实选择对应状态。M5 恢复时只回显受控执行器实际消费的 consumed_revision_id，路线是否改变由执行器回执决定，不能由模型声明。架构师使用 fact_claims、architecture_judgments、candidate_proposals 分开回报事实、推理和未来方案；只有当前事实与判断所引用的 basis_refs 必须来自 groundTruth，候选方案可以提出当前不存在的能力，但必须附验证计划。',
    inputSchema:z.object({
      status:z.enum(['succeeded', 'failed', 'waiting_test']).default('succeeded'),
      summary:z.string().min(1).max(4000),
      evidence:z.string().max(4000).optional(),
      remaining_risks:z.string().max(2000).optional(),
      evidence_refs:z.array(z.object({
        ref:z.string().min(1).max(500),
        claim:z.string().min(1).max(1000)
      })).max(30).optional(),
      unverified_claims:z.array(z.string().min(1).max(1000)).max(20).optional(),
      fact_claims:z.array(z.object({
        claim:z.string().min(1).max(1000),
        evidence_refs:z.array(z.string().min(1).max(500)).min(1).max(10)
      })).max(20).optional(),
      architecture_judgments:z.array(z.object({
        judgment:z.string().min(1).max(1200),
        basis_refs:z.array(z.string().min(1).max(500)).max(10).optional(),
        assumptions:z.array(z.string().min(1).max(600)).max(10).optional(),
        confidence:z.enum(['low', 'medium', 'high'])
      })).max(20).optional(),
      candidate_proposals:z.array(z.object({
        proposal:z.string().min(1).max(1200),
        problem:z.string().min(1).max(1000),
        validation_plan:z.string().min(1).max(1500),
        risks:z.array(z.string().min(1).max(600)).max(10).optional(),
        non_goals:z.array(z.string().min(1).max(600)).max(10).optional()
      })).max(10).optional(),
      current_state_unknowns:z.array(z.string().min(1).max(1000)).max(20).optional(),
      consumed_revision_id:z.string().min(1).max(240).optional()
    })
  }, ({
    status, summary, evidence, remaining_risks, evidence_refs, unverified_claims,
    fact_claims, architecture_judgments, candidate_proposals, current_state_unknowns,
    consumed_revision_id
  }) => client.completePaperclipAssignment({
    ...paperclipIdentityFromEnvironment(),
    status,
    summary,
    evidence,
    remainingRisks:remaining_risks,
    evidenceRefs:evidence_refs,
    unverifiedClaims:unverified_claims,
    factClaims:fact_claims,
    architectureJudgments:architecture_judgments,
    candidateProposals:candidate_proposals,
    currentStateUnknowns:current_state_unknowns,
    consumedRevisionId:consumed_revision_id
  }));

  action('technical_repair_execute', {
    title:'执行当前受控技术修复',
    description:'仅供技术专家在 Paperclip heartbeat 中使用。读取当前指派预先批准的修复范围，委派给 A君现有隔离 Codex 修复执行器，并返回真实修改、测试与恢复检查证据。没有允许文件、测试命令或恢复检查时安全拒绝。',
    inputSchema:z.object({})
  }, () => client.executeTechnicalRepair(paperclipIdentityFromEnvironment()));

  action('operations_health_execute', {
    title:'执行当前确定性健康检查',
    description:'仅供运维官在 Paperclip heartbeat 中使用。检查固定登记的本机进程、端口和健康接口并写回结构化报告；不接受 URL、命令、路径或任意终端输入，不执行重启和外部写入。',
    inputSchema:z.object({})
  }, () => client.executeOperationsHealth(paperclipIdentityFromEnvironment()));

  action('employee_assignment_execute', {
    title:'执行当前员工指派',
    description:'仅供 A君、小R、小D和小办在 Paperclip heartbeat 中使用。按当前已核验岗位和任务类型调用各自既有受控执行器；不能指定其他任务、岗位、路径、命令或外部动作。返回 running 时再次调用本工具续查。',
    inputSchema:z.object({})
  }, () => client.executeEmployeeAssignment(paperclipIdentityFromEnvironment()));

  action('video_content_analyze_execute', {
    title:'执行当前受控视频拆解',
    description:'仅供小拆在 Paperclip heartbeat 中使用。普通拆解读取任务明确引用的转录产物；M5 画面分析只读取已核验 AssetPackage，并输出每条判断都带 frameRef、timestamp、evidenceKind 的 VisualAnalysisPackage。不抓取、不登录、不发布。',
    inputSchema:z.object({})
  }, () => client.executeContentGrowth(paperclipIdentityFromEnvironment()));

  action('content_performance_review_execute', {
    title:'执行当前受控内容表现复盘',
    description:'仅供小拆在 Paperclip heartbeat 中使用。把真实指标关联到原分析和草稿版本；没有指标时安全拒绝。',
    inputSchema:z.object({})
  }, () => client.executeContentGrowth(paperclipIdentityFromEnvironment()));

  action('platform_content_draft_execute', {
    title:'执行当前受控平台草稿生成',
    description:'仅供小创在 Paperclip heartbeat 中使用。必须引用确认稿和正式分析，最多生成三个平台草稿；不会发布或访问账号。返回 running 时再次调用本工具继续等待。',
    inputSchema:z.object({})
  }, () => client.executeContentGrowth(paperclipIdentityFromEnvironment()));

  action('video_script_package_execute', {
    title:'执行当前受控可拍脚本生成',
    description:'仅供小创在 Paperclip heartbeat 中使用。自动匹配受控参考案例并生成一版可拍脚本和内部生产包；不会生成成片、发布或访问账号。',
    inputSchema:z.object({})
  }, () => client.executeContentGrowth(paperclipIdentityFromEnvironment()));

  action('m5_stage_execute', {
    title:'执行当前 M5 专用内容阶段',
    description:'仅供 M5 配音、渲染、机器审核和发布审批 Routine。调用方不能提交 toolId、Case、路径、平台、账号或预算；执行器从当前 Paperclip Issue/Run/Case 和唯一阶段契约派生固定插件工具与参数。前置 Work Product 缺失时安全拒绝。',
    inputSchema:z.object({}),
  }, () => client.executeM5Stage(paperclipIdentityFromEnvironment()));

  return server;
}

export async function runAgentArmyMcpServer() {
  const server = createAgentArmyMcpServer();
  const transport = new StdioServerTransport();
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
  await server.connect(transport);
}

function readTool(server, name, config, handler) {
  server.registerTool(name, {
    ...config,
    annotations:{ readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false }
  }, async (input) => toolResult(() => handler(input)));
}

function actionTool(server, name, config, handler) {
  server.registerTool(name, {
    ...config,
    annotations:{ readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false }
  }, async (input) => toolResult(() => handler(input)));
}

async function toolResult(operation) {
  try {
    const value = await operation();
    return {
      content:[{ type:'text', text:humanReadableToolText(value) }],
      structuredContent:jsonObject(value)
    };
  } catch (error) {
    return {
      content:[{ type:'text', text:String(error?.message || 'Agent Army MCP 调用失败。').slice(0, 1000) }],
      isError:true
    };
  }
}

function humanReadableToolText(value) {
  const direct = formatTaskPresentation(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const tasks = value.map(formatTaskPresentation).filter(Boolean);
    if (tasks.length === value.length && tasks.length) return tasks.join('\n\n');
    if (!value.length) return '当前没有符合条件的任务。';
  }
  if (value?.mission) {
    const mission = formatTaskPresentation(value.mission);
    const children = (value.children || []).map(formatTaskPresentation).filter(Boolean);
    if (mission || children.length) return [mission, ...children].filter(Boolean).join('\n\n');
  }
  if (value?.task) {
    const task = formatTaskPresentation(value.task);
    if (task) return task;
  }
  if (typeof value?.manualText === 'string') return value.manualText;
  if (Array.isArray(value?.employees) && Array.isArray(value?.capabilities)) {
    const employees = value.employees.map((item) => `${item.name || item.agentId}：${truthText(item.capabilityTruth)}；${item.role || '岗位职责已登记'}`).join('\n');
    const capabilities = value.capabilities.map((item) => `${item.name || item.id}：${truthText(item.truth)}；${item.detail || item.status || '状态待核对'}`).join('\n');
    return [`岗位登记（不等于业务已验证）：\n${employees || '暂无岗位登记。'}`, `能力实证：\n${capabilities || '暂无能力记录。'}`].join('\n\n');
  }
  return JSON.stringify(value, null, 2);
}

function truthText(value) {
  return ({
    human_accepted:'人工已验收',
    verified:'真实任务已验证',
    live:'运行可达，待业务验证',
    configured:'已配置，待运行验证',
    declared:'仅已声明',
    not_declared:'尚未接入',
  })[value?.overall] || '状态待核对';
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return { items:Array.isArray(value) ? value : [value] };
}

export function scopeFromEnvironment() {
  const agentIds = environmentList('AGENT_ARMY_ALLOWED_AGENT_IDS');
  const taskTypes = environmentList('AGENT_ARMY_ALLOWED_TASK_TYPES');
  const restricted = agentIds.length > 0 || taskTypes.length > 0;
  const configuredTools = environmentList('AGENT_ARMY_ALLOWED_MCP_TOOLS');
  const localAiCapabilities = environmentList('AGENT_ARMY_ALLOWED_LOCAL_AI_CAPABILITIES');
  const paperclipHeartbeat = [
    process.env.PAPERCLIP_TASK_ID,
    process.env.PAPERCLIP_RUN_ID,
    process.env.PAPERCLIP_AGENT_ID
  ].every(isUuid);
  const allowedTools = paperclipHeartbeat
    ? configuredTools.filter((name) => [
        'paperclip_assignment_get',
        'agent_manual',
        'agent_proposal_create_execute',
        'technical_repair_execute',
        'operations_health_execute',
        'employee_assignment_execute',
        'video_content_analyze_execute',
        'content_performance_review_execute',
        'platform_content_draft_execute',
        'video_script_package_execute',
        'm5_stage_execute',
        'local_ai_invoke',
        'paperclip_assignment_complete'
      ].includes(name))
    : configuredTools;
  if (paperclipHeartbeat && allowedTools.length === 0) {
    throw new AgentArmyClientError('Paperclip heartbeat 没有有效工具白名单，拒绝启动 MCP 服务。');
  }
  return {
    agentIds,
    taskTypes,
    enforceToolAllowlist:paperclipHeartbeat,
    allowedTools,
    localAiCapabilities,
    allowMissions:restricted ? process.env.AGENT_ARMY_ALLOW_MISSIONS === 'true' : true
  };
}

function toolAllowed(name, scope) {
  if (scope.enforceToolAllowlist === true) {
    return Array.isArray(scope.allowedTools) && scope.allowedTools.includes(name);
  }
  return !scope.allowedTools?.length || scope.allowedTools.includes(name);
}

function paperclipIdentityFromEnvironment() {
  const identity = {
    issueId:String(process.env.PAPERCLIP_TASK_ID || '').trim(),
    runId:String(process.env.PAPERCLIP_RUN_ID || '').trim(),
    paperclipAgentId:String(process.env.PAPERCLIP_AGENT_ID || '').trim(),
    agentArmyId:String(process.env.AGENT_ARMY_AGENT_ID || '').trim()
  };
  if (![identity.issueId, identity.runId, identity.paperclipAgentId].every(isUuid) || !identity.agentArmyId) {
    throw new AgentArmyClientError('当前不是带完整身份的 Paperclip heartbeat，不能读取或回报指派。');
  }
  return identity;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function environmentList(name) {
  return [...new Set(String(process.env[name] || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function scopedCapabilities(value, scope) {
  if (!scope.agentIds.length && !scope.taskTypes.length) return value;
  return {
    ...value,
    employees:(value?.employees || []).filter((employee) => scope.agentIds.includes(employee.agentId)).map((employee) => ({
      ...employee,
      acceptedTaskTypes:(employee.acceptedTaskTypes || []).filter((taskType) => !scope.taskTypes.length || scope.taskTypes.includes(taskType))
    }))
  };
}

function scopedTaskFilter(input, scope) {
  if (scope.agentIds.length === 1) return { ...input, employee:onlyValue(scope.agentIds) };
  return input;
}

function assertReadableTask(task, scope) {
  if (scope.agentIds.length && !scope.agentIds.includes(task?.agentId)) {
    throw new AgentArmyClientError('当前员工身份不能读取不属于自己的任务。');
  }
}

function assertTaskScope({ taskType, agentId }, scope) {
  const targetAgent = String(agentId || onlyValue(scope.agentIds) || '').trim();
  if (scope.agentIds.length && (!targetAgent || !scope.agentIds.includes(targetAgent))) {
    throw new AgentArmyClientError('当前员工身份不能把任务交给其他岗位。');
  }
  if (scope.taskTypes.length && !scope.taskTypes.includes(String(taskType || '').trim())) {
    throw new AgentArmyClientError('当前员工身份不能创建这种任务。');
  }
}

function assertSingleTaskRequest({ title, description }) {
  const text = `${String(title || '')}\n${String(description || '')}`;
  const numberedItems = [...text.matchAll(/(?:^|\n)\s*([1-3])[.、)]\s+\S/g)]
    .map((match) => match[1]);
  const distinctItems = new Set(numberedItems);
  const explicitlyGrouped = /(总任务|多人任务|[两二三3]\s*项工作|前两项|统一汇报)/.test(text);
  if (distinctItems.has('1') && distinctItems.has('2') && explicitlyGrouped) {
    throw new AgentArmyClientError(
      '检测到负责人一次交办多项工作，禁止压成单员工任务。请改用 mission_create，并把每项工作分别映射到已上岗员工。'
    );
  }
}

function onlyValue(values) {
  return values.length === 1 ? values[0] : undefined;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  runAgentArmyMcpServer().catch((error) => {
    console.error(`Agent Army MCP failed: ${String(error?.message || error)}`);
    process.exit(1);
  });
}
