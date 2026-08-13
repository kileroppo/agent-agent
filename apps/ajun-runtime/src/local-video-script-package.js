import {
  M5ProductionTemplateResolutionError,
  defaultM5ProductionTemplateBinding,
  validM5ProductionTemplateBinding,
} from './m5-production-template-resolver.js';
import { LocalVideoScriptContentProtocol } from './local-video-script-content-protocol.js';
import { approveLocalVideoScriptPackage } from './local-video-script-approval.js';
import { createLocalVideoScriptFallback } from './local-video-script-fallback.ts';
import { writeLocalVideoScriptProductionPackage } from './local-video-script-production-package.js';
import { resolveRequiredSourceContext } from './local-video-script-source-context.ts';
export class LocalVideoScriptPackage {
  constructor({
    store,
    artifactsDir,
    advisor = null,
    researcher = null,
    templateResolver = null,
    allowedSourceArtifactRoots = [],
    now = () => new Date(),
  } = {}) {
    this.store = store;
    this.artifactsDir = artifactsDir;
    this.advisor = advisor;
    this.researcher = researcher;
    this.templateResolver = templateResolver;
    this.allowedSourceArtifactRoots = Array.isArray(allowedSourceArtifactRoots)
      ? allowedSourceArtifactRoots.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    this.now = now;
  }

  async execute(task, { allowAdvisor = true, allowResearch = true } = {}) {
    const tasks = typeof this.store?.list === 'function' ? await this.store.list() : [];
    if (task.input?.approvedForUse === true) return this.approve(task, tasks);
    const topic = text(task.input?.contentGoal || task.input?.topic || task.input?.title, 500);
    if (!topic) {
      return needsInput(
        this.now(),
        'script_topic_required',
        '请用一句话说明这条视频要讲什么。',
      );
    }

    const requiredSources = await resolveRequiredSourceContext({
      task,
      tasks,
      allowedRoots:this.allowedSourceArtifactRoots,
    });
    if (requiredSources.error) {
      return needsInput(this.now(), requiredSources.error.code, requiredSources.error.userMessage);
    }
    const sourceContext = requiredSources.sourceContext;
    const sourceTaskBindings = explicitSourceTaskBindings(task, tasks);

    const contentProtocol = this.#contentProtocol({ allowResearch });
    const prepared = contentProtocol.prepare({ task, tasks, topic });
    const isM5Script = prepared.isM5Script;
    const pipelineCaseId = task.input?.context?.pipelineCaseId;
    const templateBinding = isM5Script
      ? await resolveTemplateBinding(this.templateResolver, pipelineCaseId)
      : null;
    if (isM5Script && !validM5ProductionTemplateBinding(templateBinding)) {
      return needsInput(
        this.now(),
        'm5_template_binding_invalid',
        'M5 生产模板绑定缺少完整 canonical hash 或安全控制，已停止脚本生成。',
      );
    }
    const grayTemplateBinding = isM5Script
      ? await resolveGrayTemplateBinding(this.templateResolver, pipelineCaseId)
      : null;
    if (!validGrayTemplateBinding(grayTemplateBinding, pipelineCaseId)) {
      return needsInput(
        this.now(),
        'm5_gray_template_binding_invalid',
        'M5 灰度模板没有完整绑定到当前日期 Case 的抖音独立内容变体。',
      );
    }

    const draft = await contentProtocol.compose({
      task,
      allowAdvisor,
      templateBinding,
      grayTemplateBinding,
      prepared,
      sourceContext,
    });
    if (draft.status === 'needs_input') {
      return needsInput(this.now(), draft.code, draft.userMessage);
    }

    const completedAt = this.now().toISOString();
    const artifact = await writeLocalVideoScriptProductionPackage({
      artifactsDir:this.artifactsDir,
      task,
      data:{
        ...draft.script,
        topic:draft.topic,
        referenceMatch:draft.reference.publicMatch,
        researchStatus:draft.research?.status || 'not_required',
        templateLifecycle:isM5Script ? {
          caseOnly:true,
          state:templateBinding.decisionStatus,
          approvedForUse:false,
          templateBinding,
        } : { caseOnly:true, state:null, approvedForUse:false },
        publishingStatus:'draft_only',
        generationMode:draft.advisorApplied ? 'hermes_advisor' : 'deterministic_fallback',
        sourceContext,
        templateGuidanceHash:draft.advisorApplied
          ? String(draft.script.templateBindingHash || '')
          : null,
        ...(draft.variants ? { variants:draft.variants } : {}),
        generatedAt:completedAt,
      },
      sources:draft.sources,
      sourceRefs:[
        ...new Set([
          ...draft.sourceRefs,
          ...sourceTaskBindings.flatMap((binding) => binding.artifactIds),
        ]),
      ],
      sourceTaskBindings,
      completedAt,
    });
    return success(task, artifact, completedAt, draft.modelUsage);
  }

  async approve(task, tasks) {
    const result = await approveLocalVideoScriptPackage({
      task, tasks, artifactsDir:this.artifactsDir, now:this.now,
    });
    if (result.error) return needsInput(this.now(), result.error.code, result.error.userMessage);
    return success(task, result.artifact, result.completedAt, null, 'video_script_package_approved');
  }
  async research(topic, task) {
    return this.#contentProtocol().research(topic, task);
  }

  #contentProtocol({ allowResearch = true } = {}) {
    return new LocalVideoScriptContentProtocol({
      advisor:this.advisor,
      researcher:this.researcher,
      research:allowResearch ? (topic, task) => this.research(topic, task) : async () => null,
      fallback:createLocalVideoScriptFallback,
    });
  }
}

function explicitSourceTaskBindings(task, tasks) {
  const requiredTaskIds = new Set(
    (Array.isArray(task.input?.context?.requiredSourceTaskIds)
      ? task.input.context.requiredSourceTaskIds : [])
      .map((item) => text(item, 120))
      .filter(Boolean),
  );
  const taskIds = [...new Set([
    ...(Array.isArray(task.input?.context?.sourceTaskIds) ? task.input.context.sourceTaskIds : []),
    ...(Array.isArray(task.input?.context?.requiredSourceTaskIds) ? task.input.context.requiredSourceTaskIds : []),
  ].map((item) => text(item, 120)).filter(Boolean))];
  return taskIds.map((taskId) => {
    const sourceTask = tasks.find((item) => String(item?.taskId || '') === taskId);
    const artifactIds = [...new Set((sourceTask?.artifactRefs || [])
      .filter((artifact) => artifact?.type !== 'employee_role_report'
        && (!requiredTaskIds.has(taskId)
          || ['confirmed_transcript', 'video_content_analysis_report'].includes(artifact?.type))
        && artifact?.validation?.exists !== false
        && artifact?.validation?.readable !== false)
      .map((artifact) => text(artifact?.artifactId, 240))
      .filter(Boolean))];
    return { taskId, artifactIds };
  });
}

async function resolveTemplateBinding(resolver, pipelineCaseId) {
  if (typeof resolver?.resolve !== 'function') {
    return defaultM5ProductionTemplateBinding('resolver_unavailable');
  }
  try {
    return await resolver.resolve(pipelineCaseId);
  } catch (error) {
    if (
      error instanceof M5ProductionTemplateResolutionError
      || error?.code === 'm5_production_template_blocked'
    ) throw error;
    return defaultM5ProductionTemplateBinding('resolver_read_failed');
  }
}

async function resolveGrayTemplateBinding(resolver, pipelineCaseId) {
  if (typeof resolver?.resolveGrayForDay !== 'function') return null;
  try {
    return await resolver.resolveGrayForDay(pipelineCaseId);
  } catch (error) {
    if (
      error instanceof M5ProductionTemplateResolutionError
      || error?.code === 'm5_production_template_blocked'
    ) throw error;
    return null;
  }
}

function validGrayTemplateBinding(binding, pipelineCaseId) {
  return !binding || (
    validM5ProductionTemplateBinding(binding)
    && binding.source === 'approved_single_gray'
    && binding.applicationScope === 'full_content_variant'
    && binding.grayTargetDayCaseId === pipelineCaseId
    && binding.grayTargetPlatform === 'douyin'
  );
}

function text(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function needsInput(now, code, userMessage) {
  const current = typeof now === 'function' ? now() : now;
  return {
    status:'needs_input',
    currentStage:code,
    error:{
      code,
      userMessage,
      category:'needs_input',
      stage:'video_script_input',
      occurredAt:current.toISOString(),
    },
  };
}

function success(task, artifact, completedAt, modelUsage = null, mode = 'video_script_package') {
  return {
    status:'succeeded',
    currentStage:`${mode}_ready`,
    execution:{
      executor:task.assigneeAgentId,
      mode,
      startedAt:task.execution?.startedAt || completedAt,
      finishedAt:completedAt,
      outcome:'artifact_ready',
    },
    usage:{
      tools:[{ id:`${mode}-write`, name:'可拍脚本与受控生产包', calls:1 }],
      ...(modelUsage?.model ? { model:modelUsage.model } : {}),
    },
    artifactRefs:[artifact],
  };
}
