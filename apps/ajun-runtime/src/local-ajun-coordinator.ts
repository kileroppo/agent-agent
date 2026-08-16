import { canonicalizeBusinessAssignment } from './business-task-routing.ts';
import { normalizeBusinessMissionContext } from './business-mission-context.ts';

export class LocalAjunCoordinator {
  now: () => Date; advisor: any; registry: any;
  constructor({ now = () => new Date(), advisor = null, registry = null }: any = {}) { this.now = now; this.advisor = advisor; this.registry = registry; }

  async execute(task: any) {
    const completedAt = this.now().toISOString();
    if (task.taskType === 'army.cross-agent-mission') return missionPlan(task, completedAt);
    if (task.taskType === 'content.campaign-topic') return campaignTopicSelection(task, completedAt);
    const recommendation: any = await this.recommend(task.input);
    const record = {
      receivedAt: task.createdAt,
      completedAt,
      normalizedRequest: task.input.title,
      contextProvided: Boolean(task.input.description),
      recommendedTaskType: recommendation.taskType,
      recommendedAgentId: recommendation.agentId,
      nextAction: recommendation.nextAction,
      autoContinue: recommendation.autoContinue === true,
      ...(recommendation.advisor ? { advisor:recommendation.advisor } : {}),
      externalActionStarted: false
    };
    return {
      status: 'succeeded', currentStage: 'intake_record_ready',
      execution: { executor: 'ajun', mode: 'local_intake_review', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: 'recorded' },
      artifactRefs: [{ artifactId: `intake-record:${task.taskId}`, taskId: task.taskId, type: 'task_intake_record', title: '任务接收与下一步建议', location: `runtime://${task.taskId}/intake-record`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: completedAt, data: record }]
    };
  }

  async recommend(input: any): Promise<any> {
    const recommendation = recommend(input);
    if (recommendation.taskType || !this.advisor?.advise) return recommendation;
    try {
      const employees = this.registry?.list ? await this.registry.list() : [];
      const advice = await this.advisor.advise({ request:`${input.title || ''}\n${input.description || ''}`.trim(), employees });
      if (!advice) return recommendation;
      const architect = employees.find((employee: any) => employee?.agentId === 'architect' && employee?.status === 'active' && Array.isArray(employee?.acceptedTaskTypes) && employee.acceptedTaskTypes.includes('governance.architecture-review'));
      if (architect && safeForCapabilityReview(input)) {
        return {
          taskType:'governance.architecture-review', agentId:'architect', autoContinue:true,
          nextAction:`我理解你想要的是：${advice.understanding}。最后要拿到：${advice.deliverable}。当前没有能直接交付这件事的员工；我会先交给架构师评估现有能力缺口和最小可验证的下一步${advice.missing.length ? `。目前还缺：${advice.missing.join('、')}` : ''}`,
          advisor:advice
        };
      }
      return {
        ...recommendation,
        nextAction: `我理解你想要的是：${advice.understanding}。最后要拿到：${advice.deliverable}。现在先做：${advice.safeNextStep}${advice.missing.length ? `。还缺：${advice.missing.join('、')}` : ''}`,
        advisor:advice
      };
    } catch {
      return recommendation;
    }
  }
}

function campaignTopicSelection(task: any, completedAt: string) {
  const fields = task.input?.context?.pipelineCase?.fields || {};
  const theme = String(fields.theme || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const scheduledDate = String(fields.scheduledDate || '').trim();
  if (!theme || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    const error: Error & { code?: string; category?: string; retryable?: boolean } = new Error('选题 Routine 缺少 Paperclip 日期 Case 中的 theme 或 scheduledDate。');
    error.code = 'm5_topic_case_context_missing';
    error.category = 'configuration';
    error.retryable = false;
    throw error;
  }
  const selection = {
    schemaVersion:'agent.army/topic-selection/v1',
    theme,
    scheduledDate,
    targetAudience:'想把 AI Agent 从聊天演示推进到可验收工作流的实操者',
    coreConclusion:`用一个可核验的真实步骤说明“${theme}”，不把配置或测试结果冒充实际业务完成。`,
    requiredSources:{
      minimum:2,
      accepted:['项目真实产物或运行证据', '公开的一手官方资料'],
      status:'pending_research',
    },
    prohibitedClaims:[
      '无法回到来源的行业数字',
      '把本机或测试页面结果说成真实平台发布',
      '夸大收益、效果或权限范围',
      '泄露本机路径、Token、Cookie、聊天原文或账号信息',
    ],
    platforms:['douyin', 'xiaohongshu'],
    scoring:{
      evidenceCompleteness:{ score:0, reason:'研究阶段尚未完成，不能预填证据分。' },
      visualizationPotential:{ score:3, reason:'主题可用本机界面、录屏或示意图展示真实步骤。' },
      audienceValue:{ score:3, reason:'围绕可执行结果和失败恢复，面向实操受众。' },
      historicalDuplication:{ score:null, reason:'尚未取得可信历史内容指标，不猜测重复度。' },
    },
    selected:true,
    selectionBasis:'活动草案已由负责人预先限定7天主题；A君只确认当日唯一日期 Case，不自行追逐热点。',
    externalActionStarted:false,
  };
  return {
    status:'succeeded',
    currentStage:'campaign_topic_selected',
    execution:{
      executor:'ajun',
      mode:'m5_topic_selection',
      startedAt:task.execution?.startedAt || completedAt,
      finishedAt:completedAt,
      outcome:'selected',
    },
    artifactRefs:[{
      artifactId:`topic-selection:${task.taskId}`,
      taskId:task.taskId,
      type:'topic_selection',
      title:`M5 选题 / ${scheduledDate}`,
      location:`runtime://${task.taskId}/topic-selection`,
      mimeType:'application/json',
      accessScope:'local-owner',
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        structured:true,
        sourceMinimumDeclared:true,
        externalSideEffects:false,
      },
      createdAt:completedAt,
      data:selection,
    }],
  };
}

function safeForCapabilityReview(input: any) {
  return !/外发|发布|删除|付款|付费|扩权|敏感|账号|登录|连接/.test(`${input?.title || ''} ${input?.description || ''}`);
}

function missionPlan(task: any, createdAt: string) {
  const businessItems = normalizeBusinessMissionItems(task.input?.context?.businessMissionItems);
  if (businessItems.length) {
    const plan = {
      missionId:task.taskId,
      kind:'business',
      safeOnly:task.input?.context?.missionSafeOnly === true,
      summary:String(task.input?.context?.businessMissionSummary || task.input?.title || '完成老板交办的多人协作任务。').trim().slice(0, 500),
      subtasks:businessItems,
      prohibitedActions:['未经批准的登录','未经批准的外发','未经批准的付费','未经批准的公开发布','未经批准的删除','未经批准的扩权'],
      createdAt
    };
    return missionPlanResult(task, plan, createdAt);
  }
  const plan = {
    missionId: task.taskId,
    kind:'army-review',
    safeOnly: true,
    summary: '盘点军团当前运行状态，并提出下一步改进建议。',
    subtasks: [
      { key:'health', agentId:'operator', taskType:'operations.health-review', title:'检查军团本机运行状态', acceptance:'给出 A君、Paperclip 和小D的健康结论。' },
      { key:'architecture', agentId:'architect', taskType:'governance.architecture-review', title:'复盘军团当前重复工作与能力缺口', acceptance:'给出有证据的改进建议；没有证据不得建议新增员工。' }
    ],
    prohibitedActions:['登录','外发','付费','公开发布','删除','扩权'],
    createdAt
  };
  return missionPlanResult(task, plan, createdAt);
}

function missionPlanResult(task: any, plan: any, createdAt: string) {
  return {
    status:'running', currentStage:'mission_planned',
    execution:{ executor:'ajun', mode:'cross_agent_mission_plan', startedAt:task.execution?.startedAt || createdAt, finishedAt:createdAt, outcome:'subtasks_ready' },
    artifactRefs:[{ artifactId:`mission-plan:${task.taskId}`, taskId:task.taskId, type:'cross_agent_mission_plan', title:'多人协作分工', location:`runtime://${task.taskId}/mission-plan`, mimeType:'application/json', accessScope:'local-owner', validation:{ exists:true, readable:true, nonEmpty:true, safeOnly:true }, createdAt, data:plan }]
  };
}

function normalizeBusinessMissionItems(value: any) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 11) return [];
  return value.map((item, index) => canonicalizeBusinessAssignment({
    key:String(item?.key || `work-${index + 1}`).trim().slice(0, 80),
    agentId:String(item?.agentId || '').trim().slice(0, 80),
    taskType:String(item?.taskType || '').trim().slice(0, 120),
    title:String(item?.title || '').trim().slice(0, 500),
    description:String(item?.description || '').trim().slice(0, 2000),
    acceptance:String(item?.acceptance || '交付可验证结果；无法完成时明确说明卡点和下一步。').trim().slice(0, 500),
    sourceUrls:Array.isArray(item?.sourceUrls) ? item.sourceUrls.map((url: any) => String(url || '').trim()).filter(Boolean).slice(0, 5) : [],
    reviewPolicy:item?.reviewPolicy === 'required' ? 'required' : 'optional',
    evidenceMode:item?.evidenceMode === 'preliminary' ? 'preliminary' : 'formal',
    analysisIntent:['digest', 'deep', 'template', 'style'].includes(item?.analysisIntent) ? item.analysisIntent : undefined,
    depth:item?.depth === 'full' ? 'full' : 'fast',
    visualMode:item?.visualMode === 'off' || item?.visualMode === 'required' ? item.visualMode : 'auto',
    focus:String(item?.focus || '').trim().slice(0, 500),
    platforms:Array.isArray(item?.platforms) ? item.platforms.map((platform: any) => String(platform || '').trim()).filter(Boolean).slice(0, 3) : [],
    contentGoal:String(item?.contentGoal || '').trim().slice(0, 500),
    researchMode:item?.researchMode === 'off' ? 'off' : 'auto',
    approvedForUse:item?.approvedForUse === true,
    proposalOnly:item?.proposalOnly === true,
    draftOnly:item?.draftOnly === true,
    deterministicAcceptanceRepair:item?.deterministicAcceptanceRepair === true,
    context:normalizeBusinessMissionContext(item?.context),
    dependsOnPrevious:item?.dependsOnPrevious === true || String(item?.agentId || '').trim() === 'office-assistant',
    dependsOn:Array.isArray(item?.dependsOn)
      ? [...new Set(item.dependsOn.map((key: any) => String(key || '').trim()).filter(Boolean))].slice(0, 10)
      : []
  }, { index })).filter((item) => item.agentId && item.taskType && item.title);
}

function recommend(input: any): any {
  const text = `${input.title || ''} ${input.description || ''}`.toLowerCase();
  const hasPublicLink = Boolean(input.sourceUrl);
  if (/创建.*agent|新建.*agent|创建.*智能体|新建.*智能体|创建.*岗位|招.*agent/.test(text)) return { taskType: 'governance.agent-proposal', agentId: 'creator', nextAction: '创建官只生成岗位草案并提交审核；不会直接创建生产 Agent、Skill 或外部连接。' };
  if (/(?:获取|读取|查看|导出|整理|分析).{0,24}(?:微信).{0,12}(?:聊天|群聊)|(?:微信).{0,12}(?:聊天|群聊).{0,24}(?:获取|读取|查看|导出|整理|分析)/.test(text)) return { taskType:'wechat.chat.retrieval', agentId:'wechat-chat-retriever', nextAction:'创建“微信聊天只读取件”任务；默认今天至现在、最多 200 条，同名会话自动选最近活跃的一条，只需确认一次隐私范围。' };
  if (/审核|审查|发布|外发|删除|付款|付费|扩权|敏感|权限/.test(text)) return { taskType: 'governance.approval-review', agentId: 'reviewer', nextAction: '创建“范围与风险审查”任务；审核官只给出风险与补充信息结论，最终决定仍由 A君完成。' };
  if (/架构|能力|边界|规划|演进|岗位/.test(text)) return { taskType: 'governance.architecture-review', agentId: 'architect', nextAction: '创建“架构师能力评估”任务，盘点现有岗位、缺口与下一条可验证的推进建议。' };
  if (/视频|音频|youtube|bilibili|抖音|快手|转录|字幕|transcri/.test(text)) return { taskType: 'media.transcribe-and-refine', agentId: 'xiaod', nextAction: '创建“小D转录整理”任务，并附上公开素材链接。' };
  if (hasPublicLink || /网页|文章|公开资料|摘要|报告/.test(text)) return { taskType: 'report.public-material', agentId: null, nextAction: '创建“公开网页摘要”任务，仅读取公开网页并交付中文摘要。' };
  if (/健康|状态|服务|运行|paperclip/.test(text)) return { taskType: 'operations.health-review', agentId: 'operator', nextAction: '创建“本机健康检查”任务，获取 A君与 Paperclip 的当前状态。' };
  return { taskType: null, agentId: null, nextAction: '当前没有唯一可执行岗位。请补充目标、交付物或选择具体任务类型；不会自动触发外部动作。' };
}
