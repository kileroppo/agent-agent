export class AgentManualService {
  constructor({ registry }) {
    if (!registry) throw new TypeError('AgentManualService 需要岗位注册表。');
    this.registry = registry;
  }

  async get({ agent, requesterAgentIds = [] } = {}) {
    const manifests = (await this.registry.list({ includeManagers:true }))
      .filter((manifest) => manifest.status === 'active' && manifest.userManual);
    const requesterIds = normalizeList(requesterAgentIds);
    const canReadAll = requesterIds.length === 0 || requesterIds.includes('ajun');
    const requested = String(agent || '').trim();

    if (isAllRequest(requested)) {
      if (!canReadAll) {
        throw new Error('当前 Agent 只能回答自己的使用说明书；查询全部或其他岗位请询问 A君。');
      }
      const manuals = manifests.map(manualFromManifest);
      return {
        mode:'all',
        count:manuals.length,
        manuals,
        manualText:manuals.map(formatManual).join('\n\n---\n\n'),
      };
    }

    if (!requested) {
      if (requesterIds.length === 1) {
        return this.singleManual(manifests, requesterIds[0], requesterIds, canReadAll);
      }
      return {
        mode:'index',
        count:manifests.length,
        agents:manifests.map(({ agentId, name, role }) => ({ agentId, name, role })),
        manualText:[
          '可以查询以下已上岗 Agent 的使用说明书：',
          ...manifests.map((item) => `- ${item.name}（${item.agentId}）：${item.role}`),
          '',
          '请指定 Agent 名称；A君也可以传 all 查询全部说明书。',
        ].join('\n'),
      };
    }

    const target = findManifest(manifests, requested);
    if (!target) throw new Error(`没有找到“${requested}”的已上岗 Agent 使用说明书。`);
    return this.singleManual(manifests, target.agentId, requesterIds, canReadAll);
  }

  singleManual(manifests, agentId, requesterIds, canReadAll) {
    if (!canReadAll && !requesterIds.includes(agentId)) {
      throw new Error('当前 Agent 只能回答自己的使用说明书；查询其他岗位请询问 A君。');
    }
    const manifest = manifests.find((item) => item.agentId === agentId);
    if (!manifest?.userManual) throw new Error(`岗位 ${agentId} 没有可用的使用说明书。`);
    const manual = manualFromManifest(manifest);
    return { mode:'single', manual, manualText:formatManual(manual) };
  }
}

function manualFromManifest(manifest) {
  return {
    agentId:manifest.agentId,
    name:manifest.name,
    role:manifest.role,
    entry:manifest.interaction?.directFeishu === 'required'
      ? '可直接私聊该 Agent 的飞书 Bot，也可由 A君转派。'
      : '没有独立飞书入口；请在飞书找 A君转派，或由 Paperclip 按需唤醒。',
    ...manifest.userManual,
  };
}

function formatManual(manual) {
  return [
    `# ${manual.name}使用说明书`,
    '',
    '## 它是什么',
    manual.whatItIs,
    '',
    '## 省了什么人工',
    `- 之前：${manual.savesWork.before}`,
    `- 现在：${manual.savesWork.now}`,
    `- 量化：${manual.savesWork.measurement}`,
    '',
    '## 用了什么工具',
    ...manual.tools.map((item) => `- ${item}`),
    '',
    '## 输入',
    ...manual.inputs.map((item) => `- ${item}`),
    '',
    '## 如何触发',
    manual.entry,
    manual.trigger,
    '',
    '示例：',
    manual.examplePrompt,
    '',
    '## 输出',
    ...manual.outputs.map((item) => `- ${item}`),
    '',
    '## 输出示例',
    manual.outputExample,
    '',
    '## 成功运行证据',
    `- 证据状态：${evidenceStatusText(manual.successEvidence.status)}`,
    `- ${manual.successEvidence.summary}`,
    ...manual.successEvidence.references.map((item) => `- 证据引用：${item}`),
    '',
    '## 怎么用',
    ...manual.usageSteps.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## 注意事项',
    ...manual.limitations.map((item) => `- ${item}`),
  ].join('\n');
}

function evidenceStatusText(status) {
  return ({
    verified:'已有可核验证据',
    'record-only':'已有运行记录，尚未补公开截图',
    'pending-screenshot':'已知需补成功截图',
  })[status] || status;
}

function findManifest(manifests, query) {
  const normalized = normalize(query);
  const exact = manifests.find((manifest) => [
    manifest.agentId,
    manifest.name,
    ...(manifest.userManual?.aliases || []),
  ].some((value) => normalize(value) === normalized));
  if (exact) return exact;
  const partial = manifests.filter((manifest) => [
    manifest.agentId,
    manifest.name,
    ...(manifest.userManual?.aliases || []),
  ].some((value) => normalize(value).includes(normalized) || normalized.includes(normalize(value))));
  return partial.length === 1 ? partial[0] : null;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[\s·._()（）【】\[\]-]+/g, '');
}

function normalizeList(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function isAllRequest(value) {
  return /^(all|全部|所有|全员|所有agent|全部agent)$/i.test(normalize(value));
}
