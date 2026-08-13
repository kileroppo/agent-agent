import { formatPublicReportReply } from './public-report-presentation.js';
import { formatOfficeBriefingReply } from './local-office-assistant.js';
import { resolveAnalysisIntent } from './analysis-intent.ts';
import { validateTaskCompletion } from './task-completion-contract.js';
import { DEFAULT_TASK_DEFINITION_REGISTRY } from './task-definition-registry.js';
import { taskStatusLabel as canonicalTaskStatusLabel, taskStatusPriority } from './task-status-policy.js';
import { projectTaskNotification } from './task-notification-projection.js';

export { safeAgentId, safeLoopbackBaseUrl, safeRef } from './feishu-commander-input.js';
export { employeeCapabilityTruth, employeeRole } from './feishu-employee-status-presentation.js';

const CREATE_AGENT_RE = /(?:创建|新建|招募|招)\s*(?:一个\s*)?.{0,80}?(?:agent|智能体|岗位|助手)/i;
const PROGRESS_RE = /进度|进展|做到哪|处理得怎么样|完成了吗|结果呢|任务状态/;
const EXPLICIT_TASK_CREATION_RE = /(?:创建|新建|发起|安排)\s*(?:一个|一项|个|项)?\s*(?:测试)?任务/i;
const EXPLICIT_NO_TASK_RE = /(?:不要|不用|无需|不需要|禁止|别)\s*(?:创建|新建|发起|安排)\s*(?:一个|一项|个|项)?\s*(?:测试)?任务/i;
export const TASK_ROUTING_DECISION_SCHEMA_VERSION = 'agent.army/feishu-task-routing-decision/v1';
export const USAGE_RE = /花了多少|花费|成本|费用|消耗|用量|token|账单|开销|实际使用/i;
export const FOLLOW_UP_RE = /^(?:需要|处理|继续|好的|好|行|可以|开始)$/;
export const PAUSE_RE = /(?:暂停|先别做|先停)/;
export const RESUME_RE = /(?:恢复|继续).*(?:任务|处理|执行)|^(?:继续|恢复)$/;
export const RETRY_XIAOD_RE = /^\s*重试\s*小\s*D\s*任务(?:\s+[0-9a-f-]{8,})?\s*$/i;
export const CONTINUE_XIAOD_DELIVERY_RE = /^\s*(?:继续|重试)\s*飞书交付(?:\s+[0-9a-f-]{8,})?\s*$/i;
const POSITIVE_FEEDBACK_RE = /(?:不错|满意|有用|很好|挺好|做得好|谢谢|辛苦了)/;
const NEGATIVE_FEEDBACK_RE = /(?:不行|不对|有问题|重做|重新做|改一下|需要改进|没用|不好)/;
const HEALTH_RE = /健康|状态|服务|运行|paperclip|检查系统/i;
export const CAPABILITIES_RE = /(?:你|军团|现在).*(?:能干什么|能做什么|可以做什么|能帮我什么|有什么能力)|(?:能干什么|能做什么|可以做什么|能帮我什么|有什么能力).*(?:你|军团|现在)?/i;
const OPERATIONS_TRIAGE_RE = /(?:怀疑|担心|看看|查(?:一下|下)?|检查|判断).{0,48}(?:异常|故障|出问题|卡住|卡死)|(?:异常|故障|出问题|卡住|卡死).{0,80}(?:安全(?:处理|恢复)|谁(?:来|该)接手|怎么处理|需要我做什么)/i;
const MEDIA_RE = /视频|音频|转录|字幕|整理素材|youtube|bilibili|抖音|快手|transcri/i;
export const VIDEO_SCRIPT_RE = /(?:写|生成|做|出).{0,20}(?:视频)?(?:脚本|口播稿|拍摄稿)|按.{0,40}(?:套路|结构|视频|案例).{0,40}(?:写|生成|做|出)|(?:脚本|口播稿).{0,40}(?:主题|关于)/i;
const VIDEO_ANALYSIS_MODE_RE = /总结|提炼|精华|快速看懂|重点是什么|深度拆解|完整分析|完整拆解|为什么有效|学习方法|13\s*模块|模板学习|提取模板|学习模板|复用结构|开头套路|填空模板|换种风格|风格探索|专业版|幽默版|故事版|数据版/iu;
export const USE_THIS_VERSION_RE = /^\s*(?:用这版|就这版|采用这版|按这版做|这版可以)\s*[。！!]?\s*$/;
export const SCRIPT_REVISION_RE = /(?:更像我|更口语|更自然|节奏快|节奏慢|短一点|长一点|改(?:一下|成)|重写|开头.{0,12}(?:换|改)|语气.{0,12}(?:换|改))/i;
const OFFICE_RE = /办公汇报|汇报包|整理成(?:文档|表格|清单)|任务清单|会议材料|会议纪要|把.{0,40}(?:结果|材料).{0,20}整理/i;
export const TASK_ID_RE = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i;

export class FeishuCommanderValidationError extends Error {}

export function conversationControlIntent(text) {
  if (FOLLOW_UP_RE.test(text) || PAUSE_RE.test(text) || RESUME_RE.test(text) || feedbackSentiment(text)) return { intent:'known_command' };
  return null;
}

function explicitTaskCreationPlan(text) {
  const value = String(text || '').trim();
  if (!EXPLICIT_TASK_CREATION_RE.test(value)) return null;
  if (/(?:全面|详细报告|岗位能力|能力和运行|任务状态.{0,30}运行健康)/i.test(value)) {
    return { intent:'architecture_review' };
  }
  if (HEALTH_RE.test(value)) return { intent:'health_check' };
  return null;
}

export function taskTypeForIntent(intent) {
  return DEFAULT_TASK_DEFINITION_REGISTRY.taskTypeForIntent(intent);
}

export function taskRoutingDecision(text) {
  const value = String(text || '').trim();
  if (isDirectReplyWithoutTask(value)) return null;
  const asksHowToCreate = /(?:如何|怎么|怎样|能否|可以|是否).{0,24}(?:创建|新建|发起|安排).{0,12}任务/i.test(value);
  if (EXPLICIT_TASK_CREATION_RE.test(value) && !asksHowToCreate) {
    const plan = explicitTaskCreationPlan(value) || { intent:'intake' };
    return {
      schemaVersion:TASK_ROUTING_DECISION_SCHEMA_VERSION,
      action:'create_task',
      intent:plan.intent,
      taskType:taskTypeForIntent(plan.intent),
      confidence:0.99,
      referencesExistingTask:false,
      reason:'explicit_task_creation',
    };
  }
  const query = progressQueryFor(value);
  if (!query) return null;
  return {
    schemaVersion:TASK_ROUTING_DECISION_SCHEMA_VERSION,
    action:'query_task',
    intent:'task_progress',
    taskType:null,
    confidence:query.taskId ? 1 : 0.9,
    referencesExistingTask:true,
    reason:query.taskId ? 'task_id_reference' : 'progress_query',
    query,
  };
}

export function isDirectReplyWithoutTask(text) {
  const value = String(text || '').trim();
  if (!EXPLICIT_NO_TASK_RE.test(value)) return false;
  return /(?:直接|只(?:需|要)?)(?:在(?:当前|本)?会话)?回复|(?:不要|不用|无需|不需要|禁止|别)\s*(?:调用|使用)\s*(?:任何)?工具/i.test(value);
}

export function directIntent(text) {
  // 这里只是 AI 不可用时的保底，不再作为正常中文的第一道入口。
    if (/(?:你是谁|你是做什么|你.*负责什么|介绍.*你自己|介绍.*自己|你.*什么身份)/i.test(text)) return { intent:'identity' };
    if (CREATE_AGENT_RE.test(text)) return { intent:'agent_proposal' };
    if (/多人|多位|多个员工|大家一起|军团协作|协同.*(?:员工|军团)|组织.*(?:盘点|复盘|协作)/.test(text)) return { intent:'cross_agent_mission' };
    if (PROGRESS_RE.test(text)) return { intent:'task_progress' };
    if (USAGE_RE.test(text)) return { intent:'usage_report' };
    if (/(?:日报|工作汇报|工作总结|今天.*(?:完成了什么|做了什么|干了什么|工作情况)|(?:总结|汇报).*(?:今天|军团|工作))/i.test(text)) return { intent:'army_report' };
    if (isOperationsTriageRequest(text)) return { intent:'health_check' };
    if (/多少.*(?:员工|agent|助手)|谁.*(?:在干|忙|卡住)|(?:员工|军团).*(?:状态|情况|进度)|(?:今天|现在|目前).*(?:需要我|要我).*(?:处理|决定|确认|补充)|(?:有什么|哪些).*(?:需要我|要我).*(?:处理|决定|确认|补充)/i.test(text)) return { intent:'army_overview' };
    if (CAPABILITIES_RE.test(text)) return { intent:'army_capabilities' };
    if (HEALTH_RE.test(text)) return { intent:'health_check' };
    if (VIDEO_SCRIPT_RE.test(text)) return { intent:'route_task', taskType:'content.video-script-package', agentId:'content-creator' };
    const analysisPlan = videoAnalysisPlan(text);
    if (analysisPlan) return analysisPlan;
    if (MEDIA_RE.test(text)) return { intent:'media_task' };
    if (OFFICE_RE.test(text)) return { intent:'office_briefing' };
    if (isGithubRequest(text)) return { intent:'github_search' };
    if (isIntelResearchRequest(text)) return { intent:'intel_research' };
    if (publicUrl(text)) return { intent:'public_report' };
    if (/优先.*(?:做|处理)|怎么推进|安排.*(?:合适|员工|人).*做|最值得.*(?:做|处理)|下一步.*(?:做|处理)/.test(text)) return { intent:'army_planning' };
    if (/重复.*工作|反复.*事情|需要.*新员工|岗位.*缺口|能力.*缺口|架构.*评估|复盘.*工作/.test(text)) return { intent:'architecture_review' };
    return { intent:'intake' };
}

function videoAnalysisPlan(text) {
  if (!VIDEO_ANALYSIS_MODE_RE.test(text) || !(MEDIA_RE.test(text) || publicUrl(text))) return null;
  const analysis = resolveAnalysisIntent({ title:text });
  if (analysis.error === 'analysis_intent_conflict') {
    return { intent:'clarify', reply:'检测到多个分析模式，请只选精华提炼、深度拆解、模板学习或风格探索中的一种。' };
  }
  return { intent:'route_task', taskType:'content.video-benchmark-analysis', agentId:'video-content-analyst' };
}

export function isSafePublicResearchRequest(text) {
  const value = String(text || '');
  if (/(?:登录|账号|密码|cookie|付费|购买|下单|外发|发送给|私密|内部资料|绕过)/i.test(value)) return false;
  return /(?:查找|搜索|查一查|研究|对比|了解|收集|整理).{0,80}(?:公开|竞品|产品介绍|产品资料|网页|文章|案例)/i.test(value);
}

export function isGithubRequest(text) {
  const value = String(text || '');
  if (/(?:github|git\s*hub|开源项目|开源仓库)/i.test(value)) return true;
  return /(?:^|\s|[“"'`（(])([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)(?=$|\s|[，。,.；;）)"'`])/i.test(value);
}
export function isIntelResearchRequest(text) {
  const value = String(text || '');
  if (/(?:登录|账号|密码|cookie|付费|购买|下单|外发|发送给|私密|内部资料|绕过)/i.test(value)) return false;
  return /(?:研究|调研|情报).{0,100}(?:主题|结论|建议|行动|背景|发现|问题)|(?:背景|关键发现|结论|行动建议|未决问题)/i.test(value);
}
export function githubTaskInput(text) {
  const value = String(text || '');
  const urlMatch = value.match(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/[^\s]*)?/i);
  const shortMatch = value.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  const repo = urlMatch ? `${urlMatch[1]}/${urlMatch[2]}` : shortMatch?.[1] || '';
  if (!repo) return { query:githubSearchQuery(value) };
  const explicitPath = value.match(/(?:文件|file|路径|path)\s*[：:]?\s*([A-Za-z0-9_./-]+)/i)?.[1];
  return { repo, ...(explicitPath ? { path:explicitPath } : {}) };
}

function githubSearchQuery(value) {
  // GitHub repository search does not reliably match a full Chinese request.
  // Keep the original request as the task title, but pass a precise public
  // repository query to the API for the common governance vocabulary.
  if (/(?:agent|智能体).{0,12}(?:治理|管控|权限)|(?:治理|管控|权限).{0,12}(?:agent|智能体)/i.test(value)) return 'agent governance';
  if (/多智能体|multi[\s-]?agent/i.test(value)) return 'multi-agent';
  return value.trim();
}

export function looksLikeWorkRequest(text) {
  return /(?:帮我|请(?:你)?|给我|安排|做一下|做个|做一份|整理|查找|查询|搜索|研究|分析|规划|生成|写(?:一份|个)?|制作|建立|修复|测试|评估|对比|翻译|总结)/i.test(String(text || ''));
}

export function isEmployeeStatusQuestion(text) {
  return /(?:最近(?:在)?(?:干|做)(?:了)?(?:啥|什么)|目前(?:在)?(?:干嘛|干什么|做什么|忙什么)|现在(?:在)?(?:干嘛|干什么|做什么|忙什么)|当前(?:在)?(?:干嘛|干什么|做什么|忙什么)|正在(?:干嘛|干什么|做什么|忙什么)|在干(?:嘛|什么)|在做(?:嘛|什么)|忙(?:什么|啥)|(?:工作)?状态|(?:最近|当前|工作)?情况|(?:工作)?进展|卡住)/i.test(String(text || ''));
}

export function namedEmployeeStatusTarget(text, employees) {
  const value = compactMention(text);
  const matches = (employees || []).filter((employee) => {
    const names = [employee.name, employee.agentId]
      .map(compactMention)
      .filter((name) => name.length >= 2);
    return names.some((name) => value.includes(name));
  });
  return matches.length === 1 ? matches[0].agentId : null;
}

function compactMention(value) {
  return String(value || '').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
}

export function isXiaodLinkRequest(text) {
  return /小\s*d/i.test(String(text || '')) && /(?:链接|网址|url|验证|补充)/i.test(String(text || ''));
}

export function linkClarificationPlan(text, reply = '') {
  const needsXiaod = isXiaodLinkRequest(text);
  return {
    intent:'clarify',
    reply: reply || (needsXiaod ? '请提供需要小D补充或验证的具体链接。' : /链接|网址|url/i.test(text) ? '请把需要处理或验证的链接发给我。' : undefined),
    ...(needsXiaod ? { awaitingLinkFor:{ taskType:'media.transcribe-and-refine', agentId:'xiaod' } } : {})
  };
}

function formatVideoScriptReply(report) {
  if (report.templateLifecycle?.approvedForUse === true) {
    return '已采用这版。可拍脚本和制作包已经准备好；没有生成成片，也没有发布。';
  }
  const notes = Array.isArray(report.shootingNotes)
    ? report.shootingNotes.slice(0, 3).map((item) => `- ${item}`).join('\n')
    : '';
  return [
    '【可拍脚本】',
    `标题：${report.headline}`,
    `建议：${report.platform || 'douyin'}｜约 ${report.durationSeconds || 45} 秒`,
    '',
    `开场：${report.hook}`,
    '',
    report.fullScript,
    ...(notes ? ['', '拍摄提示：', notes] : []),
    '',
    '下一步：满意就回复“用这版”；要改直接说一句，例如“更像我说话”或“节奏快一点”。'
  ].join('\n');
}

export function replyFor(task, taskType) {
  const notification = projectTaskNotification(task);
  const artifacts = notification.artifacts;
  if (task.status === 'succeeded' && !validateTaskCompletion(task).valid) {
    return {
      kind:'completion_waiting_test',
      task,
      reply:`“${shortTitle(task)}”已经停止运行，但完成产物没有通过对应任务门禁；已转交待测试，不会冒充成功。\n任务号：${task.taskId}。`,
    };
  }
  if (['waiting_test', 'failed', 'cancelled'].includes(task.status)) {
    return { kind:'task_status', task, reply:notification.statusReply };
  }
  if (taskType === 'operations.health-review') {
    const report = artifacts.health_report?.data;
    return { kind: 'health_review', task, reply: report ? healthReviewReply(task, report) : `运维官已接手检查，任务号：${task.taskId}。` };
  }
  if (taskType === 'media.transcribe-and-refine') {
    if (!task.input?.sourceUrl) return { kind: 'media_task', task, reply: `已收到素材整理请求。请再发送一条可公开访问的视频或音频链接；未开始处理。任务号：${task.taskId}。` };
    if (task.status === 'needs_input' || task.status === 'waiting_approval') {
      const reason = task.error?.userMessage || task.routing?.reason || '小D还没有接到可执行的任务。';
      return { kind:'media_task', task, reply:`小D尚未开始处理：${reason}\n任务号：${task.taskId}。` };
    }
    if (task.execution?.executor !== 'xiaod' && task.assigneeAgentId !== 'xiaod') {
      return { kind:'media_task', task, reply:`小D尚未开始处理：任务还没有正确路由到小D。\n任务号：${task.taskId}。` };
    }
    return { kind: 'media_task', task, reply: `已交给小D处理公开素材，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'report.public-material') {
    const report = artifacts.public_web_report?.data;
    if (report) return { kind: 'public_report', task, reply: formatPublicReportReply(report, { taskTitle:task.input?.title }) };
    if (task.status === 'needs_input') return { kind: 'public_report', task, reply: task.error?.userMessage || '这次公开网页整理还缺少必要信息，暂时没有开始读取。' };
    if (!task.input?.sourceUrl) return { kind: 'public_report', task, reply: `已收到公开网页整理请求。请再发送一条能直接打开的网页链接；未开始读取。任务号：${task.taskId}。` };
    return { kind: 'public_report', task, reply: `已交给公开网页摘要员工处理，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'research.github-search') {
    const artifact = task.artifactRefs?.find((item) => ['research_github_report', 'github_code_read'].includes(item.type))?.data;
    if (artifact) return { kind:'github_search', task, reply:formatGithubReply(artifact) };
    if (task.status === 'needs_input') return { kind:'github_search', task, reply:task.currentStage === 'waiting_for_agent_activation' ? '小R的 GitHub 检索能力尚未启用，不能开始检索。' : task.error?.userMessage || '小R还缺少检索条件，暂未开始。' };
    return { kind:'github_search', task, reply:`已交给小R检索公开 GitHub 信息，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'research.intel-report') {
    const report = artifacts.intel_research_report?.data;
    if (report) return { kind:'intel_research', task, reply:formatIntelReply(report) };
    if (task.status === 'needs_input') return { kind:'intel_research', task, reply:task.currentStage === 'waiting_for_agent_activation' ? '小R目前还是草案，尚未通过审核和受限测试，不能开始研究。' : task.error?.userMessage || '小R还缺少研究条件，暂未开始。' };
    return { kind:'intel_research', task, reply:`已交给小R研究，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'office.briefing-package') {
    const report = artifacts.office_briefing_package?.data;
    if (report) return { kind:'office_briefing', task, reply:formatOfficeBriefingReply(report) };
    if (task.status === 'needs_input') return { kind:'office_briefing', task, reply:task.error?.userMessage || '办公执行助理还缺少需要整理的材料。' };
    return { kind:'office_briefing', task, reply:`已交给办公执行助理整理，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'office.presentation-package') {
    const source = artifacts.office_presentation_source;
    const pptx = artifacts.office_pptx_document;
    if (source?.validation?.structuralQaPassed) {
      return {
        kind:'office_presentation',
        task,
        reply:[
          `小办已生成可编辑 PPTD：${source.location}`,
          pptx?.validation?.visualQaPassed
            ? `PPTX 和图片质检已完成：${pptx.location}`
            : task.error?.userMessage || 'PPTX 和图片质检尚未完成。',
        ].join('\n'),
      };
    }
    if (task.status === 'needs_input') return { kind:'office_presentation', task, reply:task.error?.userMessage || '小办还缺少演示文稿标题或逐页提纲。' };
    return { kind:'office_presentation', task, reply:`已交给小办制作演示文稿，任务号：${task.taskId}。PPTD、PPTX 和视觉质检会分别报告。` };
  }
  if (taskType === 'office.knowledge-summary') {
    const note = artifacts.knowledge_summary_note;
    if (note?.validation?.readable) return { kind:'knowledge_summary', task, reply:`小办已完成知识归档：${note.title}\n受控文件：${note.location}` };
    if (task.status === 'needs_input') return { kind:'knowledge_summary', task, reply:task.error?.userMessage || '小办还缺少需要归档的任务或材料。' };
    return { kind:'knowledge_summary', task, reply:`已交给小办总结并归档，任务号：${task.taskId}。` };
  }
  if (taskType === 'content.video-benchmark-analysis' || taskType === 'content.performance-review') {
    if (task.status === 'needs_input') return { kind:'content_analysis', task, reply:task.error?.userMessage || '小拆还缺少确认稿或表现数据。' };
    return { kind:'content_analysis', task, reply:`已交给小拆处理，任务号：${task.taskId}。完成后会回到当前飞书会话。` };
  }
  if (taskType === 'content.platform-draft') {
    if (task.status === 'needs_input') return { kind:'content_draft', task, reply:task.error?.userMessage || '小创还缺少确认稿、正式分析或目标平台。' };
    return { kind:'content_draft', task, reply:`已交给小创生成可审核草稿，任务号：${task.taskId}。不会自动发布。` };
  }
  if (taskType === 'content.video-script-package') {
    const script = artifacts.video_script_package?.data;
    if (script?.fullScript) return { kind:'content_script', task, reply:formatVideoScriptReply(script) };
    if (task.status === 'needs_input') return { kind:'content_script', task, reply:task.error?.userMessage || '小创还缺少视频主题。' };
    return { kind:'content_script', task, reply:'已交给小创生成一版可拍脚本。完成后会回到当前飞书会话。' };
  }
  if (taskType === 'governance.architecture-review') {
    const report = artifacts.architecture_review?.data;
    const patterns = report?.workEvidence?.frequentPatterns || [];
    const opportunities = report?.roleOpportunities || [];
    const nextAction = report?.nextAction || '这些建议不会自动上线；先用一条真实验收任务确认后再继续。';
    const understood = report?.understoodRequest;
    if (understood?.outcome && understood?.deliverable) {
      const missing = Array.isArray(understood.missing) && understood.missing.length
        ? understood.missing.slice(0, 4).join('、')
        : '暂时没有确认可供处理的原始材料';
      return {
        kind:'architecture_review',
        task,
        reply:`我已让架构师评估这件具体工作。\n目标：${understood.outcome}\n交付物：${understood.deliverable}\n当前缺少：${missing}\n安全下一步：${nextAction}\n边界：没有创建新员工、登录账号、外发或假装已经完成。`
      };
    }
    if (opportunities.length) return { kind:'architecture_review', task, reply:`我已让架构师复盘真实工作：发现 ${patterns.length} 类重复事项，并形成 ${opportunities.length} 个新岗位草案建议；建议：${nextAction}` };
    return { kind:'architecture_review', task, reply:patterns.length ? `我已让架构师复盘真实工作：发现 ${patterns.length} 类重复事项。建议：${nextAction}` : `我已让架构师复盘真实工作。建议：${nextAction}` };
  }
  const intake = artifacts.task_intake_record?.data;
  return { kind: 'intake', task, reply: intake?.nextAction || `已收到任务，任务号：${task.taskId}。请补充具体交付物或发送“检查系统状态”“整理视频 + 链接”“创建一个 Agent”。` };
}

export function isOperationsTriageRequest(text) {
  const value = String(text || '');
  return OPERATIONS_TRIAGE_RE.test(value) || (HEALTH_RE.test(value) && /(?:异常|故障|问题|卡住|处理建议|恢复|接手)/i.test(value));
}
export function isArchitectureReviewRequest(text) {
  return /(?:复盘|回顾|总结).{0,24}(?:最近|这次|当前|已有)?.{0,24}(?:工作|任务|结果|问题|重复)/.test(String(text || ''));
}
export function isCapabilityGapRequest(text) {
  const value = String(text || '');
  return /(?:研究|分析|对比).{0,30}(?:竞品|竞争对手).{0,30}(?:行动清单|行动建议|执行清单)|(?:行动清单|行动建议|执行清单).{0,30}(?:竞品|竞争对手)/.test(value);
}

export function directAgentIdentity(agentId) {
  const messages = {
    xiaod:'我是小D。我把已获授权的音视频素材转成可核验的转录和整理文档。',
    'intel-researcher':'我是资料研究员。我只读取公开来源，形成带证据、结论、建议和未决问题的研究报告。',
    'office-assistant':'我是办公执行助理。我把你提供的材料和其他员工的真实结果整理成文档、清单和汇报包。',
    'video-content-analyst':'我是小拆。我只基于可追溯转录证据拆解视频内容，不抓取、不发布。',
    'content-creator':'我是小创。我只根据系统或人工确认稿和正式分析生成平台草稿，不自动发布。',
    operator:'我是运维官。我检查军团运行状态、判断能否安全恢复；不能安全处理的会交给技术专家。',
    creator:'我是创建官。我把岗位需求整理成可审核的智能体草案，不会直接上线或扩权。',
    reviewer:'我是审核官。我核对权限、预算和外部动作的范围；最终敏感决定仍由负责人确认。',
    architect:'我是架构师。我根据真实任务记录评估能力缺口和最小验证方案。',
    'technical-expert':'我是技术专家。我只在有故障证据和受控范围时排查、修复和验证。',
  };
  return { kind:'identity', reply:messages[agentId] || '我是军团的受限岗位智能体，只处理本岗位允许的工作。' };
}

export function isRegisteredDraftReviewRequest(text) {
  return /(?:审核|审查).*(?:草案|岗位|员工|agent|智能体|小\s*[gr])/i.test(String(text || ''));
}

export function registeredDraftReviewReply(proposal) {
  const manifest = proposal.candidateManifest || {};
  const active = proposal.registryStatus === 'active' || proposal.status === 'active';
  const scopes = (manifest.dataScopes || []).map((item) => `${item.scope || '未命名范围'}（${stringList(item.access).join('、') || '未声明'}）`).join('；') || '未声明';
  const tools = (proposal.requestedCapabilities || []).join('、') || '无';
  const gates = (manifest.qualityGates || []).map((item) => item.gate).filter(Boolean).join('、') || '未声明';
  const reviewer = (proposal.reviewRefs || []).find((item) => item.role === 'reviewer');
  return [
    `【审核官 · ${manifest.name || '草案岗位'}】`,
    `结论：${active ? '已完成在岗权限边界复核' : reviewer?.result === 'needs_scope_before_owner_decision' ? '信息不足，暂不能提交决定' : '已完成范围审查，等待负责人决定'}`,
    `权限：${tools}`,
    `数据范围：${scopes}`,
    `质量门禁：${gates}`,
    `限制：${(manifest.nonResponsibilities || []).join('；') || '无'}`,
    `下一步：${active ? '当前岗位已经上岗；本轮只是只读复核，没有批准、上线或变更任何权限。' : proposal.trialReadiness?.message || reviewer?.summary || '负责人确认后才能进入受限测试；当前仍是草案，不会启用。'}`,
    `草案号：${proposal.proposalId}`
  ].join('\n');
}

export function stringList(value) { return (Array.isArray(value) ? value : value ? [value] : []).map((item) => String(item).trim()).filter(Boolean); }

function healthReviewReply(task, report) {
  const components = Array.isArray(report?.components) ? report.components : [];
  const abnormal = components.filter((component) => component?.status && component.status !== 'healthy');
  const evidence = components.length
    ? components.map((component) => `- ${component.name || component.id}：${component.status === 'healthy' ? '正常' : '异常'}；${component.detail || '没有更多详情。'}`)
    : ['- 本次没有取得组件级检查结果。'];
  const healthy = report?.overall === 'healthy' && abnormal.length === 0;
  const conclusion = healthy ? '暂未发现异常。' : `发现 ${abnormal.length || '需要处理的'} 个异常项。`;
  const owner = healthy ? '运维官已完成检查，无需移交。' : '运维官正在按安全边界处理；不能安全恢复的项会交给技术专家。';
  const ownerAction = healthy
    ? '现在不用做什么。若你怀疑某一件具体工作卡住，发任务名称或任务号，我会只查那一件。'
    : (report?.recommendedAction || '暂时不要重置账号、凭据或外部连接；等待运维官的下一次结果。');
  return [
    '【运维官检查结果】',
    `结论：${conclusion}`,
    '依据：', ...evidence,
    `接手：${owner}`,
    `你现在要做：${ownerAction}`,
    `任务号：${task.taskId}`
  ].join('\n');
}

export function progressReply(task) { return projectTaskNotification(task).statusReply; }

export function mostRelevantTask(tasks) {
  return [...tasks].sort((left, right) => {
    const priority = taskPriority(left.status) - taskPriority(right.status);
    if (priority) return priority;
    return taskTime(right) - taskTime(left);
  })[0] || null;
}

export function mostRecentTask(tasks) {
  return [...tasks].sort((left, right) => taskTime(right) - taskTime(left))[0] || null;
}

function progressQueryFor(text) {
  const value = String(text || '').trim();
  const taskId = value.match(TASK_ID_RE)?.[0] || null;
  if (taskId) return { taskId };
  if (!PROGRESS_RE.test(value)) return null;
  const agentId = /(?:小\s*d|小D)/i.test(value) ? 'xiaod' : null;
  return { agentId };
}

export function isTaskForAgent(task, agentId) {
  if (task.assigneeAgentId === agentId || task.execution?.executor === agentId) return true;
  return agentId === 'xiaod' && task.taskType === 'media.transcribe-and-refine';
}

export function agentDisplayName(agentId) { return agentId === 'xiaod' ? '小D' : agentId; }
export function progressHeading(task, agentId, reply) {
  const prefix = agentId ? `【${agentDisplayName(agentId)}任务进度】\n` : '';
  return `${prefix}${reply}\n任务号：${task.taskId}`;
}

export function feedbackSentiment(text) {
  // “检查有没有问题”“这个问题怎么修”是在交代工作，不是对上一件工作打分。
  // 评价必须像评价：不带提问或新的执行动作。
  if (/(?:\?|？|检查|查看|怎么|如何|有没有|是否|能否|修复|处理|系统|服务)/i.test(String(text || ''))) return null;
  if (NEGATIVE_FEEDBACK_RE.test(text)) return 'needs_improvement';
  if (POSITIVE_FEEDBACK_RE.test(text)) return 'useful';
  return null;
}

export function taskTime(task) { return Date.parse(task.updatedAt || task.createdAt || 0) || 0; }
export function workerName(task) {
  return DEFAULT_TASK_DEFINITION_REGISTRY.workerName(task) || '负责的员工';
}

export function shortTitle(task) { return String(task.input?.title || '未命名任务').replace(/\s+/g, ' ').slice(0, 48); }
export function uniqueTasks(tasks) { return [...new Map(tasks.map((task) => [shortTitle(task), task])).values()]; }

export function isVisibleEmployee(agent) { return agent.agentId !== 'creator'; }

function formatGithubReply(data) {
  if (data.repo) return [`【小R 已读取公开仓库】`, `${data.repo} · ${data.path}`, '', data.summary || '没有可提炼的文本要点。', '', `来源：${data.source || `https://github.com/${data.repo}`}`].join('\n');
  const lines = (data.results || []).map((item, index) => `${index + 1}. ${item.fullName}（★ ${item.stars}，${item.language || '语言未提供'}）\n   ${item.suitability || item.assessment || ''}${item.suitability && item.assessment ? `\n   元数据判断：${item.assessment}` : ''}\n   ${item.url}`);
  return ['【小R 公开 GitHub 检索】', `关键词：${data.query || '未提供'}`, '', ...lines, '', data.conclusion || '仅根据本次读取的公开 GitHub 元数据整理。'].join('\n');
}
function formatIntelReply(report) {
  return ['【小R 研究报告】', `主题：${report.topic || '未提供'}`, '', `背景：${report.background || '仅根据已读取来源整理。'}`, `关键发现：${(report.findings || []).map((item) => `- ${item}`).join('\n') || '- 暂无可确认发现。'}`, `结论：${report.conclusion || '无法仅根据已读取来源确认更多结论。'}`, `行动建议：${(report.recommendations || []).map((item) => `- ${item}`).join('\n') || '- 先补充可公开读取的来源。'}`, `未决问题：${(report.openQuestions || []).map((item) => `- ${item}`).join('\n') || '- 暂无。'}`, '', `来源：${(report.sources || []).map((item) => item.source).filter(Boolean).join('；') || '无'}`].join('\n');
}

export function employeeWorkState(agent, tasks) {
  const task = tasks
    .filter((item) => item.assigneeAgentId === agent.agentId)
    .sort((left, right) => taskPriority(left.status) - taskPriority(right.status))[0];
  if (!task) return '当前没有待办';
  const title = `“${shortTitle(task)}”`;
  if (task.status === 'running') return `正在处理${title}`;
  if (task.status === 'queued') return `已接到${title}，等待开始`;
  if (task.status === 'waiting_approval') return `${title}在等你确认范围`;
  if (task.status === 'pausing') return `${title}正在暂停，等待安全位置`;
  if (task.status === 'paused') return `${title}已暂停，等待继续确认`;
  if (task.status === 'waiting_test') return `${title}在待测试，其他工作不受影响`;
  if (task.status === 'needs_input') return `${title}缺少必要信息`;
  if (task.status === 'failed') return `${title}没有完成，故障记录已保留`;
  return `正在跟进${title}`;
}

export function isToday(task) {
  const value = task.updatedAt || task.createdAt;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export function taskList(tasks) { return tasks.slice(0, 3).map((task) => `“${shortTitle(task)}”`).join('、') + (tasks.length > 3 ? '等' : ''); }
export function taskStatusLine(task) {
  const title = `“${shortTitle(task)}”`;
  if (task.status === 'succeeded') return `${title}已完成`;
  if (task.status === 'running') return `${title}正在处理`;
  if (task.status === 'queued') return `${title}等待开始`;
  if (task.status === 'paused') return `${title}已暂停，等待继续确认`;
  if (task.status === 'pausing') return `${title}正在暂停，等待安全位置`;
  if (task.status === 'waiting_approval') return `${title}在等你确认范围`;
  if (task.status === 'needs_input') return `${title}缺少必要信息`;
  if (task.status === 'waiting_test') return `${title}在待测试，其他工作不受影响`;
  return `${title}暂时没有完成，原因已保留`;
}

export function shouldShowInReport(task, byId) {
  if (['operations.technical-repair', 'operations.failure-recovery'].includes(task.taskType)) return false;
  const parent = task.parentTaskId ? byId.get(task.parentTaskId) : null;
  return parent?.taskType !== 'army.cross-agent-mission';
}

function taskPriority(status) { return taskStatusPriority(status); }

export function taskStatusLabel(status) {
  return canonicalTaskStatusLabel(status) || '状态待更新';
}
export function taskUsageTime(task) {
  const value = task.usage?.recordedAt || task.updatedAt || task.createdAt;
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}
export function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
export function isCurrentConversationContext(context) {
  if (!context || !['usage_report', 'capabilities_menu'].includes(String(context.kind || ''))) return false;
  const expiresAt = Date.parse(context.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt >= Date.now();
}

export function isCurrentPendingLinkContext(context) {
  if (String(context?.kind || '') !== 'awaiting_link' || !String(context?.taskType || '').trim()) return false;
  const expiresAt = Date.parse(context.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt >= Date.now();
}
export function shouldShowRecentUsageItems(text, context) {
  if (String(context?.kind || '') !== 'usage_report') return false;
  const value = String(text || '').trim();
  return value.length <= 48 && /(?:哪|哪些|明细|具体|展开|刚才|上面|这.*项|那.*项|这.*包括什么|这.*包含什么)/.test(value);
}
export function capabilityMenuIntent(text, context) {
  if (String(context?.kind || '') !== 'capabilities_menu') return null;
  const choice = String(text || '').trim();
  if (!/^[1-6]$/.test(choice)) return null;
  return ({ '1':'army_overview', '2':'health_check', '3':'media_task', '4':'public_report', '5':'architecture_review', '6':'agent_proposal_prompt' })[choice] || null;
}

export function publicUrl(text) {
  return String(text).match(/https?:\/\/[^\s<>"'，。；：！？、【】（）《》“”‘’]+/i)?.[0]?.replace(/[)\]},.;]+$/, '') || null;
}
