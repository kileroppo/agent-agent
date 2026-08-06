const SYSTEM_ROLE = 'm5-publisher-controller';

export class PaperclipPublisherRunContext {
  constructor({
    paperclipAdapter,
    governance,
    systemRole = SYSTEM_ROLE,
  } = {}) {
    this.paperclipAdapter = paperclipAdapter;
    this.governance = governance;
    this.systemRole = systemRole;
  }

  async resolve({ heartbeat, bearerToken } = {}) {
    this.assertDependencies();
    const runId = requiredValue(heartbeat?.runId, 'Paperclip heartbeat 缺少运行标识。');
    const issueId = requiredValue(heartbeat?.context?.taskId, 'Paperclip heartbeat 缺少任务标识。');
    const apiKey = requiredValue(bearerToken, 'Paperclip Run JWT 缺失。');

    const actor = await this.paperclipAdapter.authenticateRun({ apiKey, runId });
    const actorId = requiredValue(actor?.id, 'Paperclip Run JWT 身份无效。');
    const actorCompanyId = requiredValue(actor?.companyId, 'Paperclip Run JWT 公司身份无效。');
    const verified = await this.governance.verifySystemAssignment({
      issueId,
      runId,
      paperclipAgentId:actorId,
      systemRole:this.systemRole,
    });

    const canonical = {
      issueId:requiredValue(verified?.issue?.id, 'Paperclip 核验结果缺少任务标识。'),
      runId:requiredValue(verified?.run?.id, 'Paperclip 核验结果缺少运行标识。'),
      agentId:requiredValue(verified?.paperclipAgent?.id, 'Paperclip 核验结果缺少控制器标识。'),
      companyId:requiredValue(verified?.issue?.companyId, 'Paperclip 核验结果缺少公司标识。'),
    };
    if (
      canonical.issueId !== issueId
      || canonical.runId !== runId
      || canonical.agentId !== actorId
      || canonical.companyId !== actorCompanyId
      || verified?.systemRole !== this.systemRole
      || verified?.run?.companyId !== canonical.companyId
      || verified?.paperclipAgent?.companyId !== canonical.companyId
    ) {
      throw new PaperclipPublisherRunContextError('Paperclip JWT、heartbeat 与 canonical 身份链不一致。');
    }
    return Object.freeze(canonical);
  }

  assertDependencies() {
    if (typeof this.paperclipAdapter?.authenticateRun !== 'function') {
      throw new PaperclipPublisherRunContextError('缺少 Paperclip Run JWT 认证适配器。');
    }
    if (typeof this.governance?.verifySystemAssignment !== 'function') {
      throw new PaperclipPublisherRunContextError('缺少 Paperclip 系统任务核验适配器。');
    }
  }
}

export class PaperclipPublisherRunContextError extends Error {}

export function canonicalPaperclipHeartbeat(heartbeat, canonical) {
  const input = heartbeat && typeof heartbeat === 'object' && !Array.isArray(heartbeat)
    ? heartbeat
    : {};
  const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
    ? input.context
    : {};
  return {
    ...structuredClone(input),
    runId:requiredValue(canonical?.runId, 'Paperclip canonical Run 缺失。'),
    agentId:requiredValue(canonical?.agentId, 'Paperclip canonical Agent 缺失。'),
    context:{
      ...structuredClone(context),
      taskId:requiredValue(canonical?.issueId, 'Paperclip canonical Issue 缺失。'),
    },
  };
}

function requiredValue(value, message) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new PaperclipPublisherRunContextError(message);
  return normalized;
}
