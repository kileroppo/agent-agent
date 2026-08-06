import {
  validateBudgetPayload,
  validateCompiledStage,
  validateDefinition,
  validateGoalPayload,
  validateProjectPayload,
  validateRoutinePayload,
  validateTriggerPayload,
} from './validate.js';

const marker = (kind, key) => `[agent-army:m5:${kind}:${key}]`;

const PARALLEL_ROUTINE_SPECS = [
  ['m5-evidence', 'intel-researcher', '并行证据包', '完成来源核验并写回 EvidencePackage。'],
  ['m5-assets', 'xiaod', '并行素材与关键帧', '只处理素材和关键帧并写回 AssetPackage，不输出画面分析结论。'],
  ['m5-visual-analysis', 'video-content-analyst', '并行画面分析', '只在 AssetPackage 已核验后输出 VisualAnalysisPackage；每条判断必须绑定 frameRef、timestamp 和 evidenceKind。'],
  ['m5-image-generation', 'content-creator', '并行生图', '只调用 StepFun 生图工具并写回 GeneratedImagePackage。'],
  ['m5-voice', 'content-creator', '脚本后配音', '只在 ScriptPackage 已核验后生成 VoicePackage。'],
];

function collectRequiredAgentKeys(definition) {
  return [...new Set([
    ...(definition?.stages ?? []).map((stage) => stage.owner),
    ...PARALLEL_ROUTINE_SPECS.map(([, owner]) => owner),
  ])];
}

export function listM5RequiredAgentKeys(definition) {
  return collectRequiredAgentKeys(definition);
}

export function buildBootstrapPlan(definition, bindings = {}) {
  const valid = validateDefinition(definition);
  const requiredAgentKeys = collectRequiredAgentKeys(valid);
  const resourceNamespace = String(bindings.resourceNamespace || '').trim();
  const routineIdentityMarker = (key) => resourceNamespace
    ? `[agent-army:m5:deployment:${resourceNamespace}:routine:${key}]`
    : marker('routine', key);
  const routineDescriptionMarkers = (key) => resourceNamespace
    ? `${marker('routine', key)} ${routineIdentityMarker(key)}`
    : marker('routine', key);
  const agentIds = bindings.agentIds ?? {};
  const routineIds = bindings.routineIds ?? {};
  const projectId = bindings.projectId;
  const goalId = bindings.goalId;
  const dailyControllerAgentId = bindings.dailyControllerAgentId;
  const metricsControllerAgentId = bindings.metricsControllerAgentId;
  const publisherControllerAgentId = bindings.publisherControllerAgentId;
  const retrospectiveControllerAgentId = bindings.retrospectiveControllerAgentId;
  const learningControllerAgentId = bindings.learningControllerAgentId;
  const parallelControllerAgentId = bindings.parallelControllerAgentId;
  const dailyControllerUrl = String(
    bindings.dailyControllerUrl || 'http://127.0.0.1:4321/api/paperclip/m5-daily-heartbeat',
  ).trim();
  const metricsControllerUrl = String(
    bindings.metricsControllerUrl || 'http://127.0.0.1:4321/api/paperclip/m5-metrics-heartbeat',
  ).trim();
  const publisherControllerUrl = String(
    bindings.publisherControllerUrl || 'http://127.0.0.1:4321/api/paperclip/m5-publisher-heartbeat',
  ).trim();
  const retrospectiveControllerUrl = String(
    bindings.retrospectiveControllerUrl || 'http://127.0.0.1:4321/api/paperclip/m5-retrospective-heartbeat',
  ).trim();
  const learningControllerUrl = String(
    bindings.learningControllerUrl || 'http://127.0.0.1:4321/api/paperclip/m5-learning-heartbeat',
  ).trim();
  const parallelControllerUrl = String(
    bindings.parallelControllerUrl || 'http://127.0.0.1:4321/api/paperclip/m5-parallel-heartbeat',
  ).trim();

  const stageRoutines = valid.stages
    .filter((stage) => stage.routineKey)
    .map((stage) => {
      const systemController = {
        'm5-metrics':{
          role:'m5-metrics-controller',
          agentId:metricsControllerAgentId,
        },
        'm5-publish':{
          role:'m5-publisher-controller',
          agentId:publisherControllerAgentId,
        },
        'm5-retrospective':{
          role:'m5-retrospective-controller',
          agentId:retrospectiveControllerAgentId,
        },
        'm5-learning':{
          role:'m5-learning-controller',
          agentId:learningControllerAgentId,
        },
        'm5-parallel-join':{
          role:'m5-parallel-controller',
          agentId:parallelControllerAgentId,
        },
      }[stage.routineKey] || null;
      const assigneeAgentId = systemController
        ? systemController.agentId
        : agentIds[stage.owner];
      const payload = {
        projectId: projectId ?? null,
        goalId: goalId ?? null,
        title: `M5 / ${stage.name}`,
        description: `${routineDescriptionMarkers(stage.routineKey)} 处理 ${stage.name} 阶段；当前 Case 为 {{case_id}}，版本为 {{case_version}}；产物和 Observation 写回该 Case/Issue。${stageBoundaryInstruction(stage.key)}`,
        assigneeAgentId: assigneeAgentId ?? null,
        priority: stage.kind === 'review' ? 'high' : 'medium',
        status: 'active',
        concurrencyPolicy: 'skip_if_active',
        catchUpPolicy: 'skip_missed',
        variables: [
          { name: 'case_id', label: 'Pipeline Case ID', type: 'text', required: true },
          { name: 'case_version', label: 'Case version', type: 'number', required: true },
        ],
      };
      validateRoutinePayload(payload);
      return {
        key:stage.routineKey,
        marker:routineIdentityMarker(stage.routineKey),
        owner:systemController?.role || stage.owner,
        payload,
      };
    });
  const parallelRoutines = PARALLEL_ROUTINE_SPECS.map(([key, owner, title, boundary]) => ({
    key,
    marker:routineIdentityMarker(key),
    owner,
    payload:validateRoutinePayload({
      projectId:projectId ?? null,
      goalId:goalId ?? null,
      title:`M5 / ${title}`,
      description:`${routineDescriptionMarkers(key)} 只处理并行工作分支；当前 Case 为 {{case_id}}，版本为 {{case_version}}；${boundary} 不发布、不安装技能、不读取登录态。`,
      assigneeAgentId:agentIds[owner] ?? null,
      priority:'medium',
      status:'active',
      concurrencyPolicy:'skip_if_active',
      catchUpPolicy:'skip_missed',
      variables:[
        { name:'case_id', label:'Pipeline Case ID', type:'text', required:true },
        { name:'case_version', label:'Case version', type:'number', required:true },
      ],
    }),
  }));
  const routines = [...stageRoutines, ...parallelRoutines];

  const stages = valid.stages.map((stage, position) => {
    const config = {
      whatHappensHere: `${stage.owner} 负责${stage.name}；真实产物和 Observation 写回 Paperclip。`,
      requireChildrenTerminal: stage.key === 'machine_review' || stage.key === 'publish_approval',
      requireNoUnresolvedDrift: stage.kind === 'review',
      m5Policy: {
        maxConcurrency: valid.executionPolicy.maxConcurrency,
        maxStageRetries: valid.executionPolicy.maxStageRetries,
        maxReplansPerContent: valid.executionPolicy.maxReplansPerContent,
      },
    };
    if (stage.key === 'draft' || stage.key === 'campaign_active') {
      config.autoAdvanceOnChildrenTerminal = null;
    }
    if (stage.routineKey && routineIds[stage.routineKey]) {
      config.onEnter = {
        type: 'run_routine',
        id: `m5-${stage.key}-on-enter`,
        routineId: routineIds[stage.routineKey],
        projectId: projectId ?? null,
      };
    }
    if (stage.review) {
      Object.assign(config, {
        requireApproval: true,
        approver: agentIds[stage.owner]
          ? { kind: 'agent', id: agentIds[stage.owner] }
          : { kind: 'any_human' },
        approveToStageKey: stage.review.approveTo,
        rejectToStageKey: stage.review.rejectTo,
        requestChangesToStageKey: stage.review.requestChangesTo,
        requireRejectReason: true,
        requireRequestChangesReason: true,
      });
    }
    const compiled = { key: stage.key, name: stage.name, kind: stage.kind, position, config };
    validateCompiledStage(compiled);
    return compiled;
  });

  const businessStages = valid.stages.filter((stage) => stage.kind !== 'cancelled');
  const transitions = businessStages.slice(0, -1).map((stage, index) => ({
    fromStageKey: stage.key,
    toStageKey: businessStages[index + 1].key,
    label: '推进',
  })).filter((edge) => !(
    edge.fromStageKey === 'script' && edge.toStageKey === 'render'
  ));
  transitions.push(
    { fromStageKey:'script', toStageKey:'parallel_join_gate', label:'脚本完成，等待配音和其余并行产物' },
    { fromStageKey:'parallel_join_gate', toStageKey:'render', label:'五分支汇聚完成' },
    { fromStageKey:'retrospective', toStageKey:'done', label:'样本不足，结束本次复盘' },
  );
  for (const stage of valid.stages.filter((item) => item.review)) {
    for (const [decision, toStageKey] of Object.entries({
      approve: stage.review.approveTo,
      reject: stage.review.rejectTo,
      request_changes: stage.review.requestChangesTo,
    })) {
      if (!transitions.some((edge) => edge.fromStageKey === stage.key && edge.toStageKey === toStageKey)) {
        transitions.push({ fromStageKey: stage.key, toStageKey, label: decision });
      }
    }
  }

  const scheduleRoutine = validateRoutinePayload({
    projectId: projectId ?? null,
    goalId: goalId ?? null,
    title: 'M5 / 每日内容活动入口',
    description: `${routineDescriptionMarkers('m5-daily-campaign')} 固定调用无模型 HTTP 控制器；控制器自行查询唯一 active CampaignGrant，按 Asia/Shanghai 当前日期选择唯一直接日期 Case，并只执行 draft→topic 的幂等迁移。Routine 不接收 campaignId、日期或 Case 参数，不得批量激活其他日期或任何平台 Case，不直接发布。`,
    assigneeAgentId: dailyControllerAgentId ?? null,
    priority: 'high',
    status: 'active',
    concurrencyPolicy: valid.executionPolicy.schedule.concurrencyPolicy,
    catchUpPolicy: valid.executionPolicy.schedule.catchUpPolicy,
    variables: [],
  });
  const scheduleTrigger = validateTriggerPayload({
    kind: 'schedule',
    label: 'M5 每日内容入口（7天授权期内）',
    enabled: false,
    cronExpression: valid.executionPolicy.schedule.cronExpression,
    timezone: valid.executionPolicy.schedule.timezone,
  });
  const goalPayload = validateGoalPayload({
    title: valid.goal.title,
    description: `${marker('goal', valid.goal.key)} ${valid.goal.description}`,
    level: valid.goal.level,
    status: valid.goal.status,
  });
  const projectPayload = validateProjectPayload({
    name: valid.project.name,
    description: `${marker('project', valid.project.key)} ${valid.project.description}`,
    status: valid.project.status,
    goalIds: goalId ? [goalId] : [],
  });
  const budgetPayload = {
    scopeType: 'project',
    scopeId: projectId ?? null,
    metric: valid.budget.metric,
    windowKind: valid.budget.windowKind,
    warnPercent: valid.budget.warnPercent,
    hardStopEnabled: valid.budget.hardStopEnabled,
    notifyEnabled: true,
    isActive: true,
  };
  if (projectId) validateBudgetPayload({ ...budgetPayload, amount: 1 });

  return {
    version: 1,
    sourcePaperclipVersion: valid.paperclipVersion,
    unresolved: {
      agentKeys: requiredAgentKeys.filter((key) => !agentIds[key]),
      routineKeys: routines.map((item) => item.key).filter((key) => !routineIds[key]),
      goalId: !goalId,
      projectId: !projectId,
    },
    resources: {
      dailyController: {
        key:'m5-daily-controller',
        payload:{
          name:'每日确定性控制器 M5 Daily',
          role:'devops',
          title:'只按活动授权和 Asia/Shanghai 当天日期激活唯一日期 Case',
          icon:'cog',
          capabilities:'无模型、无自由参数；只执行 M5 每日日期 Case 的幂等激活。',
          adapterType:'http',
          adapterConfig:{ url:dailyControllerUrl },
          budgetMonthlyCents:0,
          permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
          metadata:{
            agentArmySystemRole:'m5-daily-controller',
            agentArmyManagedOnly:false,
            executionOwner:'ajun-runtime-deterministic',
          },
        },
      },
      metricsController: {
        key:'m5-metrics-controller',
        payload:{
          name:'指标回流确定性控制器 M5 Metrics',
          role:'devops',
          title:'只按可信发布凭证执行 2h、24h、72h 本人内容指标回流',
          icon:'radar',
          capabilities:'无模型、无自由参数；使用 Issue Monitor 唤醒，指标写回 Work Product。',
          adapterType:'http',
          adapterConfig:{ url:metricsControllerUrl, forwardRunJwt:true },
          budgetMonthlyCents:0,
          permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
          metadata:{
            agentArmySystemRole:'m5-metrics-controller',
            agentArmyManagedOnly:false,
            executionOwner:'ajun-runtime-deterministic',
          },
        },
      },
      publisherController: {
        key:'m5-publisher-controller',
        payload:{
          name:'发布确定性控制器 M5 Publisher',
          role:'devops',
          title:'只从可信 Case 产物派生并执行唯一发布动作',
          icon:'rocket',
          capabilities:'无模型、无自由参数；只调用已启用 Publisher Gateway 并写回唯一 PublishReceipt。',
          adapterType:'http',
          adapterConfig:{ url:publisherControllerUrl, forwardRunJwt:true },
          budgetMonthlyCents:0,
          permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
          metadata:{
            agentArmySystemRole:'m5-publisher-controller',
            agentArmyManagedOnly:false,
            executionOwner:'ajun-runtime-deterministic',
          },
        },
      },
      retrospectiveController: {
        key:'m5-retrospective-controller',
        payload:{
          name:'复盘确定性控制器 M5 Retrospective',
          role:'researcher',
          title:'只读取可信 MetricSnapshot 并写入版本化复盘 Work Product',
          icon:'brain',
          capabilities:'无模型、无自由参数；少于5条同类型真实指标时只记录样本不足，达到门槛后只提出 LearningProposal。',
          adapterType:'http',
          adapterConfig:{ url:retrospectiveControllerUrl },
          budgetMonthlyCents:0,
          permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
          metadata:{
            agentArmySystemRole:'m5-retrospective-controller',
            agentArmyManagedOnly:false,
            executionOwner:'ajun-runtime-deterministic',
          },
        },
      },
      learningController: {
        key:'m5-learning-controller',
        payload:{
          name:'学习灰度确定性控制器 M5 Learning',
          role:'reviewer',
          title:'只推进离线回放、审核、单条灰度和回退状态',
          icon:'flask-conical',
          capabilities:'无模型、无自由参数；只读取可信 Work Product，绝不自动改 Prompt、扩权、加频或投流。',
          adapterType:'http',
          adapterConfig:{ url:learningControllerUrl },
          budgetMonthlyCents:0,
          permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
          metadata:{
            agentArmySystemRole:'m5-learning-controller',
            agentArmyManagedOnly:false,
            executionOwner:'ajun-runtime-deterministic',
          },
        },
      },
      parallelController:{
        key:'m5-parallel-controller',
        payload:{
          name:'并行工作确定性控制器 M5 Parallel',
          role:'devops',
          title:'只用 Paperclip Case、blockers、Routine 和 Work Product 协调并行分支',
          icon:'git-branch',
          capabilities:'无模型、无自由参数；研究、素材和生图先并行，小拆严格等待 AssetPackage，配音严格等待脚本，五项健康产物后才解锁渲染。',
          adapterType:'http',
          adapterConfig:{ url:parallelControllerUrl },
          budgetMonthlyCents:0,
          permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
          metadata:{
            agentArmySystemRole:'m5-parallel-controller',
            agentArmyManagedOnly:false,
            executionOwner:'ajun-runtime-deterministic',
          },
        },
      },
      goal: {
        key: valid.goal.key,
        marker: marker('goal', valid.goal.key),
        payload: goalPayload,
      },
      project: {
        key: valid.project.key,
        marker: marker('project', valid.project.key),
        payload: projectPayload,
      },
      routines,
      scheduleRoutine: {
        key:'m5-daily-campaign',
        marker:routineIdentityMarker('m5-daily-campaign'),
        payload:scheduleRoutine,
      },
      scheduleTrigger,
      pipeline: {
        key: valid.key,
        payload: {
          key: valid.key,
          name: valid.name,
          description: valid.description,
          projectId: projectId ?? null,
          enforceTransitions: true,
          stages,
        },
        transitions,
      },
      budget: {
        requireExplicitAmountAtApply: true,
        payload: budgetPayload,
      },
    },
  };
}

function stageBoundaryInstruction(stageKey) {
  if (stageKey === 'render') {
    return ' master本地成片与血缘验证完成后，才可将当前日期下仍为draft的抖音和小红书两个平台Case推进到machine_review；禁止提前或跨日期激活。';
  }
  return '';
}
