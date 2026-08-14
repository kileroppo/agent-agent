export function createStepFunModelPolicyConsole({ root, api, escapeHtml }) {
    let payload = null;
    let busy = false;
    let loaded = false;
    const defaultModel = root.querySelector('#fleet-default-model');
    const defaultEffort = root.querySelector('#fleet-default-effort');
    const employeeList = root.querySelector('#fleet-model-employees');
    const capabilityList = root.querySelector('#fleet-capability-models');
    const message = root.querySelector('#fleet-model-message');
    const applyAll = root.querySelector('#fleet-model-apply-all');
    const saveRoles = root.querySelector('#fleet-model-save-roles');
    const saveCapabilities = root.querySelector('#fleet-capability-save');
    const refresh = root.querySelector('#fleet-model-refresh');
    defaultModel.addEventListener('change', () => syncEffortOptions(defaultModel, defaultEffort));
    applyAll.addEventListener('click', () => save({ clearOverrides: true }));
    saveRoles.addEventListener('click', () => save({ clearOverrides: false }));
    saveCapabilities.addEventListener('click', saveCapabilityPolicy);
    refresh.addEventListener('click', refreshCatalog);
    employeeList.addEventListener('change', (event) => {
        const modelSelect = event.target.closest('select[data-role-model]');
        if (!modelSelect)
            return;
        const effortSelect = employeeList.querySelector(`select[data-role-effort="${cssEscape(modelSelect.dataset.roleModel)}"]`);
        syncEffortOptions(modelSelect, effortSelect);
    });
    capabilityList.addEventListener('change', (event) => {
        const select = event.target.closest('select[data-capability-key]');
        if (select)
            syncCapabilityDescription(select);
    });
    async function load() {
        if (busy || loaded)
            return;
        root.hidden = false;
        message.textContent = '正在读取全军模型策略…';
        try {
            render(await api('/api/model-policy'));
        }
        catch (error) {
            message.textContent = error.message;
        }
    }
    function setVisible(visible) {
        root.hidden = !visible;
    }
    function render(next) {
        payload = next;
        loaded = true;
        const reasoning = payload.catalog?.reasoning || [];
        defaultModel.replaceChildren(...reasoning.map((model) => option(model.id, `${model.name} · ${model.badge}${model.available === false ? ' · 当前账号未返回' : ''}`)));
        defaultModel.value = payload.policy.default.model;
        syncEffortOptions(defaultModel, defaultEffort, payload.policy.default.reasoningEffort);
        employeeList.innerHTML = payload.employees.map((employee) => roleRow(employee, reasoning)).join('');
        capabilityList.innerHTML = (payload.catalog?.capabilityRoutes || []).map((route) => capabilityRow(route)).join('');
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
        if (busy)
            return;
        busy = true;
        refresh.disabled = true;
        message.textContent = '正在通过 Hermes 刷新当前 StepFun 账号的模型清单…';
        try {
            const result = await api('/api/model-policy/refresh', { method: 'POST' });
            render(result);
            const account = result.catalog?.account;
            const unknown = account?.unknown?.length
                ? `；另发现 ${account.unknown.length} 个尚未纳入官方能力策略的新模型，请先查看官方说明`
                : '';
            message.textContent = `已刷新：账号返回 ${account?.models?.length || 0} 个模型，主模型与能力模型均按官方分类${unknown}。`;
        }
        catch (error) {
            message.textContent = error.message;
        }
        finally {
            busy = false;
            refresh.disabled = false;
        }
    }
    function roleRow(employee, reasoning) {
        const modelOptions = reasoning.map((model) => `<option value="${escapeHtml(model.id)}"${model.id === employee.model ? ' selected' : ''}>${escapeHtml(model.name)}</option>`).join('');
        const model = reasoning.find((item) => item.id === employee.model) || reasoning[0];
        const effortOptions = (model?.efforts || []).map((effort) => `<option value="${escapeHtml(effort)}"${effort === employee.reasoningEffort ? ' selected' : ''}>${escapeHtml(effortLabel(effort))}</option>`).join('');
        return `<article class="fleet-role-row" data-fleet-agent="${escapeHtml(employee.agentId)}">
      <div><strong>${escapeHtml(employee.name)}</strong><small>${escapeHtml(employee.role)}</small></div>
      <label><span>主模型</span><select data-role-model="${escapeHtml(employee.agentId)}">${modelOptions}</select></label>
      <label><span>推理</span><select data-role-effort="${escapeHtml(employee.agentId)}">${effortOptions}</select></label>
    </article>`;
    }
    function capabilityRow(route) {
        const selected = payload.policy?.capabilities?.[route.key] || route.options?.[0] || {};
        const selectedValue = capabilityValue(selected);
        const options = (route.options || []).map((model) => {
            const value = capabilityValue(model);
            const unavailable = model.available === false ? ' · 当前账号未返回' : '';
            return `<option value="${escapeHtml(value)}"${value === selectedValue ? ' selected' : ''}>${escapeHtml(model.name)} · ${escapeHtml(model.badge || model.provider)}${unavailable}</option>`;
        }).join('');
        return `<article class="capability-model-card">
      <span>${escapeHtml(route.capability)} · ${escapeHtml(route.owner)}</span>
      <label><strong>执行模型</strong><select data-capability-key="${escapeHtml(route.key)}">${options}</select></label>
      <small data-capability-description>${escapeHtml(capabilityDescription(route, selectedValue))}</small>
      <small class="capability-model-badge">${escapeHtml(route.summary || '')}</small>
    </article>`;
    }
    function capabilityDescription(route, value) {
        const selected = (route.options || []).find((model) => capabilityValue(model) === value);
        return selected?.summary || '';
    }
    function syncCapabilityDescription(select) {
        const route = (payload.catalog?.capabilityRoutes || []).find((item) => item.key === select.dataset.capabilityKey);
        const description = select.closest('.capability-model-card')?.querySelector('[data-capability-description]');
        if (route && description)
            description.textContent = capabilityDescription(route, select.value);
    }
    function syncEffortOptions(modelSelect, effortSelect, preferred = '') {
        if (!payload || !effortSelect)
            return;
        const model = payload.catalog.reasoning.find((item) => item.id === modelSelect.value);
        const current = preferred || effortSelect.value || model?.recommendedEffort;
        effortSelect.replaceChildren(...(model?.efforts || []).map((effort) => option(effort, effortLabel(effort))));
        effortSelect.value = model?.efforts.includes(current) ? current : model?.recommendedEffort;
    }
    async function save({ clearOverrides }) {
        if (!payload || busy)
            return;
        if (!window.confirm(clearOverrides
            ? '这会把全部员工统一为上方模型与推理强度。正在执行的会话不变，下一次任务生效。确定继续吗？'
            : '保存后，各员工下一次任务会采用这里的模型配置。确定继续吗？'))
            return;
        const defaultSelection = { model: defaultModel.value, reasoningEffort: defaultEffort.value };
        const overrides = {};
        if (!clearOverrides) {
            for (const row of employeeList.querySelectorAll('[data-fleet-agent]')) {
                const selection = {
                    model: row.querySelector('select[data-role-model]').value,
                    reasoningEffort: row.querySelector('select[data-role-effort]').value,
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
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ default: defaultSelection, overrides, capabilities: capabilitySelections() }),
            });
            render(result);
            message.textContent = result.reconciliation?.status === 'synced'
                ? '已保存：Hermes Profile 与 Paperclip 岗位配置一致，下一次任务生效。'
                : `Hermes 已保存；Paperclip 暂待补同步：${result.reconciliation?.reason || '后台会继续重试。'}`;
        }
        catch (error) {
            message.textContent = error.message;
        }
        finally {
            busy = false;
            applyAll.disabled = false;
            saveRoles.disabled = false;
        }
    }
    async function saveCapabilityPolicy() {
        if (!payload || busy)
            return;
        if (!window.confirm('保存后，小D等员工的新任务会采用这里的能力模型；正在执行的任务不变。确定继续吗？'))
            return;
        busy = true;
        saveCapabilities.disabled = true;
        message.textContent = '正在保存能力模型策略…';
        try {
            const result = await api('/api/model-policy', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    default: payload.policy.default,
                    overrides: payload.policy.overrides,
                    capabilities: capabilitySelections(),
                }),
            });
            render(result);
            message.textContent = '能力模型已保存；正在执行的会话不变，新任务按新路线执行。';
        }
        catch (error) {
            message.textContent = error.message;
        }
        finally {
            busy = false;
            saveCapabilities.disabled = false;
        }
    }
    function capabilitySelections() {
        return Object.fromEntries([...capabilityList.querySelectorAll('select[data-capability-key]')].map((select) => {
            const [provider, ...modelParts] = String(select.value).split(':');
            return [select.dataset.capabilityKey, { provider, model: modelParts.join(':') }];
        }));
    }
    function capabilityValue(selection) {
        return `${selection.provider}:${selection.model}`;
    }
    function option(value, label) {
        const node = document.createElement('option');
        node.value = value;
        node.textContent = label;
        return node;
    }
    return { load, setVisible };
}
function effortLabel(value) {
    return { none: '关闭额外推理', low: '低 · 简单任务', medium: '中 · 默认推荐', high: '高 · 复杂任务最强' }[value] || value;
}
function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '');
}
