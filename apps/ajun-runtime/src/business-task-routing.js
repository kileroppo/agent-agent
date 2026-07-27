const OFFICE_AGENT_ID = 'office-assistant';
const OFFICE_TASK_TYPE = 'office.briefing-package';

export function canonicalizeBusinessAssignment(input = {}, { index = 0 } = {}) {
  const title = text(input.title);
  const description = text(input.description);
  const acceptance = text(input.acceptance);
  const requestedTaskType = text(input.taskType);
  const requestedAgentId = text(input.agentId);
  const dependsOnPrevious = input.dependsOnPrevious === true;
  const combined = `${title}\n${description}\n${acceptance}`;
  const explicitOffice = requestedTaskType === OFFICE_TASK_TYPE || requestedAgentId === OFFICE_AGENT_ID;
  const officeDeliverable = /(?:老板|统一|最终|办公).{0,12}(?:汇报|汇总)|(?:汇报|汇总).{0,12}(?:老板|统一|最终)|汇报包/i.test(combined);
  const referencesPriorWork = /(?:基于|根据|等待|等).{0,40}(?:任务|工作|结果|产物)|前\s*[两二三23]\s*项|完成情况.{0,40}未决事项|主要结论.{0,40}下一步/i.test(combined);
  const isDependentOfficeBriefing = explicitOffice
    || (officeDeliverable && (dependsOnPrevious || index > 0 || referencesPriorWork));

  if (!isDependentOfficeBriefing) {
    return {
      ...input,
      title,
      description,
      acceptance,
      taskType:requestedTaskType,
      agentId:requestedAgentId,
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

function text(value) {
  return String(value || '').trim();
}
