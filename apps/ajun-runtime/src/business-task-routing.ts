import { DEFAULT_TASK_DEFINITION_REGISTRY } from './task-definition-registry.ts';

const OFFICE_AGENT_ID = 'office-assistant';
const OFFICE_TASK_TYPE = 'office.briefing-package';
const OFFICE_PRESENTATION_TASK_TYPE = 'office.presentation-package';
const GITHUB_TASK_TYPE = 'research.github-search';
const RESEARCH_TASK_TYPES = new Set(DEFAULT_TASK_DEFINITION_REGISTRY.taskTypesForCategory('research-entry'));

export function canonicalizeBusinessAssignment(input: Record<string, any> = {}, { index = 0 }: { index?: number } = {}) {
  const title = text(input.title);
  const description = text(input.description);
  const acceptance = text(input.acceptance);
  const requestedTaskType = text(input.taskType);
  const requestedAgentId = text(input.agentId);
  const dependsOnPrevious = input.dependsOnPrevious === true;
  const combined = `${title}\n${description}\n${acceptance}`;
  const explicitOffice = [OFFICE_TASK_TYPE, OFFICE_PRESENTATION_TASK_TYPE].includes(requestedTaskType) || requestedAgentId === OFFICE_AGENT_ID;
  const presentationDeliverable = /(?:(?:制作|生成|整理|设计|修改|输出).{0,16}(?:pptx?|幻灯片|演示文稿))|(?:(?:pptx?|幻灯片|演示文稿).{0,16}(?:制作|生成|整理|设计|修改|输出))/i.test(combined);
  const officeDeliverable = /(?:老板|统一|最终|办公).{0,12}(?:汇报|汇总)|(?:汇报|汇总).{0,12}(?:老板|统一|最终)|汇报包/i.test(combined);
  const referencesPriorWork = /(?:基于|根据|等待|等).{0,40}(?:任务|工作|结果|产物)|前\s*[两二三23]\s*项|完成情况.{0,40}未决事项|主要结论.{0,40}下一步/i.test(combined);
  const explicitVideoScript = /(?:可拍|短剧|视频脚本|分镜|镜头脚本|一人分饰)/i.test(combined)
    && /(?:脚本|口播|分镜)/i.test(combined);
  const normalizedTaskType = ['content.platform-draft', OFFICE_TASK_TYPE].includes(requestedTaskType) && explicitVideoScript
    ? 'content.video-script-package'
    : presentationDeliverable && ['army.intake', OFFICE_TASK_TYPE, OFFICE_PRESENTATION_TASK_TYPE].includes(requestedTaskType)
      ? OFFICE_PRESENTATION_TASK_TYPE
      : requestedTaskType;
  const isDependentOfficeBriefing = explicitOffice
    || (officeDeliverable && (dependsOnPrevious || index > 0 || referencesPriorWork));
  const explicitGithubResearch = RESEARCH_TASK_TYPES.has(requestedTaskType)
    && /(?:github|git\s*hub|开源项目|开源仓库)/i.test(combined);
  const fixedAgentId = DEFAULT_TASK_DEFINITION_REGISTRY.fixedAgentId(normalizedTaskType);

  if (fixedAgentId) {
    return {
      ...input,
      title,
      description,
      acceptance,
      taskType:normalizedTaskType,
      agentId:fixedAgentId,
      dependsOnPrevious
    };
  }

  if (!isDependentOfficeBriefing) {
    return {
      ...input,
      title,
      description,
      acceptance,
      taskType:explicitGithubResearch ? GITHUB_TASK_TYPE : requestedTaskType,
      agentId:explicitGithubResearch ? DEFAULT_TASK_DEFINITION_REGISTRY.defaultAgentId(GITHUB_TASK_TYPE) : requestedAgentId,
      dependsOnPrevious
    };
  }

  return {
    ...input,
    title,
    description,
    acceptance,
    taskType:OFFICE_TASK_TYPE,
    agentId:OFFICE_AGENT_ID,
    dependsOnPrevious:true
  };
}

export function githubRepositoryQuery(value: unknown) {
  const textValue = text(value);
  const explicit = textValue.match(/(?:关键词|query)\s*[：:]?\s*([A-Za-z][A-Za-z0-9_. -]{1,60})/i)?.[1]?.trim();
  if (explicit) return explicit;
  if (/(?:agent|智能体).{0,12}(?:governance|治理|管控|权限)|(?:governance|治理|管控|权限).{0,12}(?:agent|智能体)/i.test(textValue)) return 'agent governance';
  if (/多智能体|multi[\s-]?agent/i.test(textValue)) return 'multi-agent';
  if (/(?:agent|智能体).{0,20}(?:编排|协作|军团)|(?:编排|协作|军团).{0,20}(?:agent|智能体)/i.test(textValue)) return 'agent orchestration';
  return textValue;
}

function text(value: unknown) {
  return String(value || '').trim();
}
