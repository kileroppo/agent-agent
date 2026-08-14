export function createStepFunModelPolicyConsole({ root, api, escapeHtml }: any) {
  let payload: any = null;
  let busy = false;
  let loaded = false;
  const defaultModel: any = root.querySelector('#fleet-default-model');
  const defaultEffort: any = root.querySelector('#fleet-default-effort');
  const employeeList: any = root.querySelector('#fleet-model-employees');
  const capabilityList: any = root.querySelector('#fleet-capability-models');
  const message: any = root.querySelector('#fleet-model-message');
  const applyAll: any = root.querySelector('#fleet-model-apply-all');
  const saveRoles: any = root.querySelector('#fleet-model-save-roles');
  const refresh: any = root.querySelector('#fleet-model-refresh');

  defaultModel.addEventListener('change', () => syncEffortOptions(defaultModel, defaultEffort));
  applyAll.addEventListener('click', () => save({ clearOverrides:true }));
  saveRoles.addEventListener('click', () => save({ clearOverrides:false }));
  refresh.addEventListener('click', refreshCatalog);
  employeeList.addEventListener('change', (event: any) => {
    const modelSelect: any = event.target.closest('select[data-role-model]');
    if (!modelSelect) return;
    const effortSelect: any = employeeList.querySelector(`select[data-role-effort="${cssEscape(modelSelect.dataset.roleModel)}"]`);
    syncEffortOptions(modelSelect, effortSelect);
  });

  async function load() {
    if (busy || loaded) return;
    root.hidden = false;
    message.textContent = '正在读取全军模型策略…';
    try {
      render(await api('/api/model-policy'));
    } catch (error: any) {
      message.textContent = error.message;
    }
  }

  function setVisible(visible: boolean) {
    root.hidden = !visible;
  }

  function render(next: any) {
    payload = next;
    loaded = true;
    const reasoning = payload.catalog?.reasoning || [];
    defaultModel.replaceChildren(...reasoning.map((model: any) => option(
      model.id,
      `${model.name} · ${model.badge}${model.available === false ? ' · 当前账号未返回' : ''}`,
    )));
    defaultModel.value = payload.policy.default.model;
    syncEffortOptions(defaultModel, defaultEffort, payload.policy.default.reasoningEffort);
    employeeList.innerHTML = payload.employees.map((employee: any) => roleRow(employee, reasoning)).join('');
    capabilityList.innerHTML = (payload.catalog?.capabilities || []).map((model: any) => `
      <article class="capability-model-card">
        <span>${escapeHtml(model.capability)}</span>
        <strong>${escapeHtml(model.name)}</strong>
        <small>${escapeHtml(model.owner)}按任务自动调用，不占主模型位置${model.available === false ? ' · 当前账号未返回' : ''}</small>
      </article>`).join('');
    const updated = payload.policy.updatedAt
      ? `上次保存 ${new Date(payload.policy.updatedAt).toLocaleString('zh-CN')}`
      : '当前由岗位配置生成，尚未从本页保存';
    const account = payload.catalog?.account;
    const accountStatus = account
      ? ` · 账号模型已刷新 ${new Date(account.refreshedAt).toLocaleString('zh-CN')}，共 ${account.models.length} 个`
      : '';
    message.textContent = `${updated}${accountStatus} · ${payload.message}`;
  }

  async function refreshCatalog() {
    if (busy) return;
    busy = true;
    refresh.disabled = true;
    message.textContent = '正在通过 Hermes 刷新当前 StepFun 账号的模型清单…';
    try {
      const result = await api('/api/model-policy/refresh', { method:'POST' });
      render(result);
      const account = result.catalog?.account;
      const unknown = account?.unknown?.length
        ? `；另发现 ${account.unknown.length} 个尚未纳入官方能力策略的新模型，请先查看官方说明`
        : '';
      message.textContent = `已刷新：账号返回 ${account?.models?.length || 0} 个模型，主模型与能力模型均按官方分类${unknown}。`;
    } catch (error: any) {
      message.textContent = error.message;
    } finally {
      busy = false;
      refresh.disabled = false;
    }
  }

  function roleRow(employee: any, reasoning: any[]) {
    const modelOptions = reasoning.map((model: any) => `<option value="${escapeHtml(model.id)}"${model.id === employee.model ? ' selected' : ''}>${escapeHtml(model.name)}</option>`).join('');
    const model = reasoning.find((item: any) => item.id === employee.model) || reasoning[0];
    const effortOptions = (model?.efforts || []).map((effort: any) => `<option value="${escapeHtml(effort)}"${effort === employee.reasoningEffort ? ' selected' : ''}>${escapeHtml(effortLabel(effort))}</option>`).join('');
    return `<article class="fleet-role-row" data-fleet-agent="${escapeHtml(employee.agentId)}">
      <div><strong>${escapeHtml(employee.name)}</strong><small>${escapeHtml(employee.role)}</small></div>
      <label><span>主模型</span><select data-role-model="${escapeHtml(employee.agentId)}">${modelOptions}</select></label>
      <label><span>推理</span><select data-role-effort="${escapeHtml(employee.agentId)}">${effortOptions}</select></label>
    </article>`;
  }

  function syncEffortOptions(modelSelect: any, effortSelect: any, preferred = '') {
    if (!payload || !effortSelect) return;
    const model = payload.catalog.reasoning.find((item: any) => item.id === modelSelect.value);
    const current = preferred || effortSelect.value || model?.recommendedEffort;
    effortSelect.replaceChildren(...(model?.efforts || []).map((effort: any) => option(effort, effortLabel(effort))));
    effortSelect.value = model?.efforts.includes(current) ? current : model?.recommendedEffort;
  }

  async function save({ clearOverrides }: any) {
    if (!payload || busy) return;
    if (!window.confirm(clearOverrides
      ? '这会把全部员工统一为上方模型与推理强度。正在执行的会话不变，下一次任务生效。确定继续吗？'
      : '保存后，各员工下一次任务会采用这里的模型配置。确定继续吗？')) return;
    const defaultSelection = { model:defaultModel.value, reasoningEffort:defaultEffort.value };
    const overrides: Record<string, any> = {};
    if (!clearOverrides) {
      for (const row of employeeList.querySelectorAll('[data-fleet-agent]')) {
        const selection = {
          model:row.querySelector('select[data-role-model]').value,
          reasoningEffort:row.querySelector('select[data-role-effort]').value,
        };
        if (selection.model !== defaultSelection.model || selection.reasoningEffort !== defaultSelection.reasoningEffort) {
          overrides[row.dataset.fleetAgent] = selection;
        }
      }
    }
    busy = true;
    applyAll.disabled = true;
    saveRoles.disabled = true;
    message.textContent = '正在写入 Hermes 全部 Profile，并同步 Paperclip…';
    try {
      const result = await api('/api/model-policy', {
        method:'PUT',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ default:defaultSelection, overrides }),
      });
      render(result);
      message.textContent = result.reconciliation?.status === 'synced'
        ? '已保存：Hermes Profile 与 Paperclip 岗位配置一致，下一次任务生效。'
        : `Hermes 已保存；Paperclip 暂待补同步：${result.reconciliation?.reason || '后台会继续重试。'}`;
    } catch (error: any) {
      message.textContent = error.message;
    } finally {
      busy = false;
      applyAll.disabled = false;
      saveRoles.disabled = false;
    }
  }

  function option(value: string, label: string) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  return { load, setVisible };
}

function effortLabel(value: string) {
  return ({ none:'关闭额外推理', low:'低 · 简单任务', medium:'中 · 默认推荐', high:'高 · 复杂任务最强' } as Record<string, string>)[value] || value;
}

function cssEscape(value: string) {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '');
}
