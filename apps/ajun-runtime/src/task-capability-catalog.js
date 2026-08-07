const DEFINITIONS = Object.freeze([
  capability('wechat.chat.retrieval', { agentId:'wechat-chat-retriever' }),
  capability('content.video-benchmark-analysis', {
    agentId:'video-content-analyst',
    contentArtifactType:'video_content_analysis_report',
  }),
  capability('content.performance-review', {
    agentId:'video-content-analyst',
    contentArtifactType:'content_performance_report',
  }),
  capability('content.campaign-visual-analysis', {
    agentId:'video-content-analyst',
    contentArtifactType:'visual_analysis_package',
  }),
  capability('content.platform-draft', {
    agentId:'content-creator',
    contentArtifactType:'platform_content_draft',
  }),
  capability('content.video-script-package', {
    agentId:'content-creator',
    contentArtifactType:'video_script_package',
  }),
  capability('office.knowledge-summary', { agentId:'office-assistant' }),
  capability('office.presentation-package', { agentId:'office-assistant' }),
  capability('army.goal-program', { openDelegate:'army.route-task' }),
  capability('media.open-production', { openDelegate:'media.transcribe-and-refine' }),
  capability('research.open-investigation', { openDelegate:'research.intel-report' }),
  capability('office.deliverable-program', { openDelegate:'office.briefing-package' }),
  capability('operations.incident-response', { openDelegate:'operations.health-review' }),
  capability('governance.capability-design', { openDelegate:'governance.agent-proposal' }),
  capability('governance.assurance-review', { openDelegate:'governance.approval-review' }),
  capability('governance.architecture-experiment', { openDelegate:'governance.architecture-review' }),
  capability('operations.engineering-resolution', { openDelegate:'operations.technical-repair' }),
  capability('content.analysis-program', { openDelegate:'content.video-benchmark-analysis' }),
  capability('content.creation-program', { openDelegate:'content.video-script-package' }),
]);

export class TaskCapabilityCatalog {
  constructor({ definitions = DEFINITIONS, executors = {} } = {}) {
    this.definitions = new Map(definitions.map((item) => [item.taskType, item]));
    this.executors = executors;
  }

  definition(taskType) {
    return this.definitions.get(String(taskType || '').trim()) || null;
  }

  fixedAgentId(taskType) {
    return this.definition(taskType)?.agentId || null;
  }

  openDelegate(taskType) {
    return this.definition(taskType)?.openDelegate || null;
  }

  executor(agentId, executors = this.executors) {
    return executors[String(agentId || '').trim()] || null;
  }

  contentGrowthContract(taskType, agentId) {
    const definition = this.definition(taskType);
    if (!definition?.contentArtifactType || definition.agentId !== agentId) return null;
    return {
      taskType:definition.taskType,
      agentId:definition.agentId,
      artifactType:definition.contentArtifactType,
    };
  }

  openTaskDelegates() {
    return Object.freeze(Object.fromEntries(
      [...this.definitions.values()]
        .filter((item) => item.openDelegate)
        .map((item) => [item.taskType, item.openDelegate]),
    ));
  }
}

export const DEFAULT_TASK_CAPABILITY_CATALOG = new TaskCapabilityCatalog();

function capability(taskType, options) {
  return Object.freeze({ taskType, ...options });
}
