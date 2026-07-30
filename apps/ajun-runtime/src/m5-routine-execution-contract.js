const workProduct = (type, schemaVersion, artifactKinds) => Object.freeze({
  type,
  schemaVersion,
  artifactKinds:Object.freeze([...artifactKinds]),
  minCount:1,
});

export const INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT = Object.freeze({
  agentId:'intel-researcher',
  taskType:'research.open-investigation',
  maxSteps:8,
  maxSafeRetries:2,
  maxReplans:3,
  liveWiring:'employee_assignment_execute',
  paperclipWriteKinds:Object.freeze([
    'append_run_observation',
    'request_plan_revision',
    'block_issue',
    'create_work_product',
  ]),
  toolIds:Object.freeze([
    'content.public.search',
    'content.public.fetch',
    'content.public.dynamic.read',
    'content.public.pdf.read',
    'github.public.search',
    'github.public.read',
  ]),
  successConditions:Object.freeze({
    'content.public.search':'发现新的公开来源候选；结果只作读取线索，不直接作为事实证据。',
    'content.public.fetch':'读取公开静态网页，保留公开 URL、抓取时间、正文哈希和可核验证据片段。',
    'content.public.dynamic.read':'读取公开动态网页，保留公开 URL、抓取时间、正文哈希和可核验证据片段。',
    'content.public.pdf.read':'读取公开 PDF，保留公开 URL、抓取时间、正文哈希和可核验证据片段。',
    'github.public.search':'发现公开 GitHub 候选来源；仓库元数据只作线索，不直接作为事实证据。',
    'github.public.read':'读取公开 GitHub 仓库内容，保留公开 URL、抓取时间、内容哈希和证据片段。',
  }),
  controlSuccessConditions:Object.freeze({
    request_replan:'Paperclip 生成不同于失败路线的 PlanRevision；不得扩大岗位权限或重做已验证产物。',
    complete:'当前 Issue 已有满足 GoalSpec 验收条件且来源可核验的唯一 Work Product。',
  }),
});

const hermes = ({
  routineKey,
  stageKey,
  agentId,
  taskType,
  executionTool,
  pluginEntryTool = null,
  deterministicEntry = null,
  pluginTools = [],
  expectedWorkProduct,
  parallelOnly = false,
}) => Object.freeze({
  routineKey,
  stageKey,
  executionMode:'hermes',
  agentId,
  taskType,
  executionTool:Object.freeze(executionTool),
  pluginEntryTool,
  deterministicEntry,
  pluginTools:Object.freeze([...pluginTools]),
  completionTool:'paperclip_assignment_complete',
  expectedWorkProduct,
  parallelOnly,
});

const controller = ({
  routineKey,
  stageKey,
  systemController,
  expectedWorkProduct,
}) => Object.freeze({
  routineKey,
  stageKey,
  executionMode:'system_controller',
  systemController,
  taskType:null,
  executionTool:null,
  pluginTools:Object.freeze([]),
  completionTool:null,
  expectedWorkProduct,
});

export const M5_ROUTINE_EXECUTION_CONTRACTS = Object.freeze([
  hermes({
    routineKey:'m5-topic',
    stageKey:'topic',
    agentId:'ajun',
    taskType:'content.campaign-topic',
    executionTool:{ kind:'agent_army_mcp', id:'employee_assignment_execute' },
    expectedWorkProduct:workProduct('TopicSelection', 'agent.army/topic-selection/v1', ['topic_selection']),
  }),
  hermes({
    routineKey:'m5-research',
    stageKey:'research',
    agentId:'intel-researcher',
    taskType:'content.campaign-research',
    executionTool:{ kind:'agent_army_mcp', id:'employee_assignment_execute' },
    expectedWorkProduct:workProduct(
      'CampaignResearchReport',
      'agent.army/campaign-research/v2',
      ['campaign_research_report'],
    ),
    parallelOnly:true,
  }),
  hermes({
    routineKey:'m5-evidence',
    stageKey:'evidence',
    agentId:'intel-researcher',
    taskType:'content.campaign-evidence',
    executionTool:{ kind:'agent_army_mcp', id:'employee_assignment_execute' },
    expectedWorkProduct:workProduct(
      'EvidencePackage',
      'agent.army/evidence-package/v2',
      ['evidence_package'],
    ),
    parallelOnly:true,
  }),
  hermes({
    routineKey:'m5-script',
    stageKey:'script',
    agentId:'content-creator',
    taskType:'content.video-script-package',
    executionTool:{ kind:'agent_army_mcp', id:'video_script_package_execute' },
    expectedWorkProduct:workProduct(
      'ScriptPackage',
      'agent.army/video-script-package/v1',
      ['video_script_package'],
    ),
  }),
  hermes({
    routineKey:'m5-assets',
    stageKey:'assets',
    agentId:'xiaod',
    taskType:'content.campaign-assets',
    executionTool:{ kind:'agent_army_mcp', id:'employee_assignment_execute' },
    pluginTools:['stepfun-vision', 'media-probe', 'media-validate'],
    expectedWorkProduct:workProduct(
      'AssetPackage',
      'agent.army/asset-package/v1',
      ['asset_package'],
    ),
    parallelOnly:true,
  }),
  hermes({
    routineKey:'m5-visual-analysis',
    stageKey:'visual_analysis',
    agentId:'video-content-analyst',
    taskType:'content.campaign-visual-analysis',
    executionTool:{ kind:'agent_army_mcp', id:'video_content_analyze_execute' },
    pluginTools:['stepfun-vision', 'media-probe', 'media-validate'],
    expectedWorkProduct:workProduct(
      'VisualAnalysisPackage',
      'agent.army/visual-analysis-package/v1',
      ['visual_analysis_package'],
    ),
    parallelOnly:true,
  }),
  hermes({
    routineKey:'m5-image-generation',
    stageKey:'parallel_image_generation',
    agentId:'content-creator',
    taskType:'content.campaign-image-generation',
    executionTool:{ kind:'agent_army_mcp', id:'m5_stage_execute' },
    pluginEntryTool:'stepfun-image-generate',
    pluginTools:['stepfun-image-generate'],
    expectedWorkProduct:workProduct(
      'GeneratedImagePackage',
      'agent.army/generated-image-package/v1',
      ['generated_image_package'],
    ),
    parallelOnly:true,
  }),
  hermes({
    routineKey:'m5-voice',
    stageKey:'voice',
    agentId:'content-creator',
    taskType:'content.campaign-voice',
    executionTool:{ kind:'agent_army_mcp', id:'m5_stage_execute' },
    pluginEntryTool:'stepfun-tts',
    pluginTools:['stepfun-tts'],
    expectedWorkProduct:workProduct(
      'VoicePackage',
      'agent.army/voice-package/v1',
      ['voice_package'],
    ),
    parallelOnly:true,
  }),
  controller({
    routineKey:'m5-parallel-join',
    stageKey:'parallel_join_gate',
    systemController:'m5-parallel-controller',
    expectedWorkProduct:workProduct(
      'ParallelJoin',
      'agent.army/parallel-work-join/v1',
      ['parallel_work_join'],
    ),
  }),
  hermes({
    routineKey:'m5-render',
    stageKey:'render',
    agentId:'content-creator',
    taskType:'content.campaign-render',
    executionTool:{ kind:'agent_army_mcp', id:'m5_stage_execute' },
    pluginEntryTool:'remotion-render',
    pluginTools:[
      'remotion-props-write',
      'remotion-render',
      'media-finalize',
      'media-probe',
      'media-validate',
      'subtitle-layout-validate',
      'artifact-lineage-validate',
    ],
    expectedWorkProduct:workProduct(
      'RenderPackage',
      'agent.army/render-package/v1',
      ['render_package'],
    ),
  }),
  hermes({
    routineKey:'m5-machine-review',
    stageKey:'machine_review',
    agentId:'reviewer',
    taskType:'content.campaign-machine-review',
    executionTool:{ kind:'agent_army_mcp', id:'m5_stage_execute' },
    pluginEntryTool:'media-validate',
    pluginTools:[
      'media-probe',
      'media-validate',
      'subtitle-layout-validate',
      'artifact-package-write',
      'artifact-lineage-validate',
    ],
    expectedWorkProduct:workProduct(
      'MachineReview',
      'agent.army/machine-review/v1',
      ['machine_review_report'],
    ),
  }),
  hermes({
    routineKey:'m5-platform-adapt',
    stageKey:'platform_adapt',
    agentId:'content-creator',
    taskType:'content.platform-draft',
    executionTool:{ kind:'agent_army_mcp', id:'platform_content_draft_execute' },
    expectedWorkProduct:workProduct(
      'ContentVersion',
      'agent.army/content-version/v1',
      ['platform_content_draft'],
    ),
  }),
  hermes({
    routineKey:'m5-publish-approval',
    stageKey:'publish_approval',
    agentId:'reviewer',
    taskType:'content.campaign-publish-approval',
    executionTool:{ kind:'agent_army_mcp', id:'m5_stage_execute' },
    pluginEntryTool:'publish-preflight',
    pluginTools:['campaign-preflight', 'publish-preflight'],
    expectedWorkProduct:workProduct(
      'PublishApproval',
      'agent.army/publish-approval/v1',
      ['publish_approval_report'],
    ),
  }),
  controller({
    routineKey:'m5-publish',
    stageKey:'publish',
    systemController:'m5-publisher-controller',
    expectedWorkProduct:workProduct(
      'PublishReceipt',
      'agent.army/publish-receipt/v1',
      ['publish_receipt'],
    ),
  }),
  hermes({
    routineKey:'m5-verify',
    stageKey:'verify',
    agentId:'reviewer',
    taskType:'content.campaign-verify',
    executionTool:{ kind:'agent_army_mcp', id:'m5_stage_execute' },
    deterministicEntry:'publish_receipt_verify',
    expectedWorkProduct:workProduct(
      'PublishVerification',
      'agent.army/publish-verification/v1',
      ['publish_verification_report'],
    ),
  }),
  controller({
    routineKey:'m5-metrics',
    stageKey:'metrics',
    systemController:'m5-metrics-controller',
    expectedWorkProduct:workProduct(
      'MetricSnapshot',
      'agent.army/metric-snapshot/v1',
      ['metric_snapshot'],
    ),
  }),
  controller({
    routineKey:'m5-retrospective',
    stageKey:'retrospective',
    systemController:'m5-retrospective-controller',
    expectedWorkProduct:workProduct(
      'LearningProposal',
      'agent.army/learning-proposal/v1',
      ['learning_proposal'],
    ),
  }),
]);

const contractByRoutine = new Map(
  M5_ROUTINE_EXECUTION_CONTRACTS.map((contract) => [contract.routineKey, contract]),
);
const contractByStage = new Map(
  M5_ROUTINE_EXECUTION_CONTRACTS.map((contract) => [contract.stageKey, contract]),
);

export function getM5RoutineExecutionContract(routineKey) {
  return contractByRoutine.get(String(routineKey || '').trim()) || null;
}

export function getM5StageExecutionContract(stageKey) {
  return contractByStage.get(String(stageKey || '').trim()) || null;
}

export function assertM5RoutineExecutionContracts(definition) {
  const stages = (definition?.stages || []).filter((stage) => stage.routineKey);
  const failures = [];
  for (const stage of stages) {
    const contract = getM5RoutineExecutionContract(stage.routineKey);
    if (!contract) {
      failures.push(`Routine ${stage.routineKey} 缺少执行契约`);
      continue;
    }
    if (contract.stageKey !== stage.key) {
      failures.push(`Routine ${stage.routineKey} 的阶段契约不是 ${stage.key}`);
    }
    if (contract.executionMode === 'hermes' && contract.agentId !== stage.owner) {
      failures.push(`Routine ${stage.routineKey} 的岗位契约不是 ${stage.owner}`);
    }
  }
  const declared = new Set(stages.map((stage) => stage.routineKey));
  for (const contract of M5_ROUTINE_EXECUTION_CONTRACTS) {
    if (!contract.parallelOnly && !declared.has(contract.routineKey)) {
      failures.push(`执行契约 ${contract.routineKey} 没有对应 Pipeline 阶段`);
    }
  }
  if (failures.length) throw new Error(failures.join('；'));
  return M5_ROUTINE_EXECUTION_CONTRACTS;
}
