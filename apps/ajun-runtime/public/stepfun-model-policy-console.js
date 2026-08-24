import { html, raw, escapeHtml } from './html.js';
export function createStepFunModelPolicyConsole({ root, api }) {
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
    const roleSummary = root.querySelector('#fleet-role-summary');
    const defaultMaxTurns = root.querySelector('#fleet-default-max-turns');
    const roleMaxTurns = root.querySelector('#fleet-role-max-turns');
    const idleMinutes = root.querySelector('#fleet-session-idle-minutes');
    defaultModel.addEventListener('change', () => {
        syncEffortOptions(defaultModel, defaultEffort);
        syncOverrideBadges();
    });
    defaultEffort.addEventListener('change', () => syncOverrideBadges());
    applyAll.addEventListener('click', () => save({ clearOverrides: true }));
    saveRoles.addEventListener('click', () => save({ clearOverrides: false }));
    saveCapabilities.addEventListener('click', saveCapabilityPolicy);
    refresh.addEventListener('click', refreshCatalog);
    employeeList.addEventListener('change', (event) => {
        const modelSelect = event.target.closest('select[data-role-model]');
        if (modelSelect) {
            const effortSelect = employeeList.querySelector(`select[data-role-effort="${cssEscape(modelSelect.dataset.roleModel)}"]`);
            syncEffortOptions(modelSelect, effortSelect);
        }
        syncOverrideBadges();
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
        defaultMaxTurns.value = payload.policy.runtime.defaultMaxTurns;
        roleMaxTurns.value = payload.policy.runtime.roleMaxTurns;
        idleMinutes.value = payload.policy.runtime.idleMinutes;
        syncOverrideBadges();
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
        const modelOptions = reasoning.map((model) => html `<option value="${model.id}"${model.id === employee.model ? ' selected' : ''}>${model.name}</option>`).join('');
        const model = reasoning.find((item) => item.id === employee.model) || reasoning[0];
        const efforts = (model?.efforts || []).filter((effort) => effort !== 'none');
        const selectedEffort = efforts.includes(employee.reasoningEffort) ? employee.reasoningEffort : (model?.recommendedEffort || efforts[0]);
        const effortOptions = efforts.map((effort) => html `<option value="${effort}"${effort === selectedEffort ? ' selected' : ''}>${effortLabel(effort)}</option>`).join('');
        return html `<article class="fleet-role-row" data-fleet-agent="${employee.agentId}">
      <div class="fleet-role-head"><strong>${employee.name}</strong><small>${employee.role}</small><span class="fleet-role-badge" hidden>已覆盖</span></div>
      <div class="fleet-role-controls">
        <label><span>主模型</span><select data-role-model="${employee.agentId}">${raw(modelOptions)}</select></label>
        <label><span>推理</span><select data-role-effort="${employee.agentId}">${raw(effortOptions)}</select></label>
      </div>
    </article>`;
    }
    function syncOverrideBadges() {
        const rows = [...employeeList.querySelectorAll('[data-fleet-agent]')];
        let overridden = 0;
        for (const row of rows) {
            const differs = row.querySelector('select[data-role-model]')?.value !== defaultModel.value
                || row.querySelector('select[data-role-effort]')?.value !== defaultEffort.value;
            if (differs)
                overridden += 1;
            row.classList.toggle('is-override', differs);
            row.querySelector('.fleet-role-badge')?.toggleAttribute('hidden', !differs);
        }
        if (roleSummary) {
            roleSummary.textContent = overridden
                ? `${overridden}/${rows.length} 个岗位已单独覆盖，其余跟随全军默认。`
                : '全部岗位跟随全军默认；只改有特殊需要的岗位。';
        }
    }
    function capabilityRow(route) {
        const selected = payload.policy?.capabilities?.[route.key] || route.options?.[0] || {};
        const selectedValue = capabilityValue(selected);
        const options = (route.options || []).map((model) => {
            const value = capabilityValue(model);
            const unavailable = model.available === false ? '（当前账号未返回）' : '';
            return html `<option value="${value}"${value === selectedValue ? ' selected' : ''}>${model.name}${unavailable}</option>`;
        }).join('');
        return html `<article class="capability-model-card">
      <span>${route.capability} · ${route.owner}</span>
      <label><strong>执行模型</strong><select data-capability-key="${route.key}">${raw(options)}</select></label>
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
        const efforts = (model?.efforts || []).filter((effort) => effort !== 'none');
        effortSelect.replaceChildren(...efforts.map((effort) => option(effort, effortLabel(effort))));
        effortSelect.value = efforts.includes(current) ? current : (efforts.includes(model?.recommendedEffort) ? model.recommendedEffort : efforts[0]);
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
                body: JSON.stringify({ default: defaultSelection, overrides, capabilities: capabilitySelections(), runtime: runtimePolicy() }),
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
                    capabilities: capabilitySelections(), runtime: runtimePolicy(),
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
    function runtimePolicy() {
        return { defaultMaxTurns: Number(defaultMaxTurns.value), roleMaxTurns: Number(roleMaxTurns.value), idleMinutes: Number(idleMinutes.value) };
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
    return { low: '低', medium: '中', high: '高' }[value] || value;
}
function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '');
}
