const ACTIVE_STATES = new Set([
    'checking', 'preparing_source', 'verifying', 'freezing', 'activating',
    'verifying_live', 'rolling_back',
]);
const STAGE_ORDER = [
    ['checking', '核对代码'],
    ['preparing_source', '准备新版'],
    ['verifying', '完整检查'],
    ['freezing', '生成版本'],
    ['activating', '切换服务'],
    ['verifying_live', '确认上线'],
];
export function releaseActionAvailability(status) {
    const active = ACTIVE_STATES.has(status?.state);
    return {
        checking: active,
        canPublish: status?.state === 'ready' && status?.candidate?.clean === true,
        canRollback: !active && Boolean(status?.rollback?.releaseHash),
    };
}
export function releaseStageView(status) {
    const state = String(status?.state || 'idle');
    const action = String(status?.action || '');
    const stages = action === 'rollback'
        ? [['rolling_back', '退回上一版'], ['verifying_live', '确认恢复']]
        : STAGE_ORDER;
    const activeIndex = stages.findIndex(([key]) => key === state);
    const terminalComplete = state === 'succeeded' || state === 'up_to_date';
    return stages.map(([key, label], index) => ({
        key,
        label,
        state: terminalComplete || (activeIndex >= 0 && index < activeIndex)
            ? 'done'
            : index === activeIndex ? 'active' : 'pending',
    }));
}
export function createRuntimeReleaseConsole({ root, api, confirmAction = window.confirm.bind(window) }) {
    if (!root)
        return { activate() { } };
    const current = root.querySelector('#release-current');
    const candidate = root.querySelector('#release-candidate');
    const rollback = root.querySelector('#release-rollback');
    const message = root.querySelector('#release-message');
    const stages = root.querySelector('#release-stages');
    const checkButton = root.querySelector('#release-check');
    const publishButton = root.querySelector('#release-publish');
    const rollbackButton = root.querySelector('#release-rollback-action');
    let status = null;
    let timer = null;
    let active = false;
    let disconnectedDuringAction = false;
    function shortHash(value) {
        const text = String(value || '').trim();
        return text ? text.slice(0, 8) : '未知';
    }
    function render(next) {
        status = next;
        const actions = releaseActionAvailability(status);
        current.textContent = status?.current?.releaseHash ? shortHash(status.current.releaseHash) : '尚未读取';
        candidate.textContent = status?.candidate?.gitHead
            ? status.state === 'up_to_date' ? '当前已是最新版' : shortHash(status.candidate.gitHead)
            : '先检查新版';
        rollback.textContent = status?.rollback?.releaseHash ? shortHash(status.rollback.releaseHash) : '暂无可退回版本';
        message.textContent = status?.message || '尚未检查新版。';
        message.dataset.state = status?.state || 'idle';
        stages.replaceChildren(...releaseStageView(status).map((item) => {
            const li = document.createElement('li');
            li.className = `release-stage is-${item.state}`;
            li.innerHTML = `<span aria-hidden="true">${item.state === 'done' ? '✓' : item.state === 'active' ? '•' : ''}</span><strong>${item.label}</strong>`;
            return li;
        }));
        checkButton.disabled = actions.checking;
        publishButton.disabled = !actions.canPublish;
        rollbackButton.disabled = !actions.canRollback;
    }
    function schedulePoll(delay = 1500) {
        clearTimeout(timer);
        if (!active)
            return;
        timer = setTimeout(refresh, delay);
    }
    async function refresh() {
        try {
            const payload = await api('/api/runtime-release/status');
            disconnectedDuringAction = false;
            render(payload.status);
            if (ACTIVE_STATES.has(payload.status?.state))
                schedulePoll();
        }
        catch (error) {
            if (ACTIVE_STATES.has(status?.state) || disconnectedDuringAction) {
                disconnectedDuringAction = true;
                message.textContent = 'A君正在重启，等待重新连接…';
                schedulePoll(1800);
                return;
            }
            message.textContent = error.message || '暂时无法读取版本状态。';
        }
    }
    async function post(action, body = {}) {
        const session = await api('/api/owner-action-session');
        const nonce = String(session?.nonce || '').trim();
        if (!nonce)
            throw new Error('暂时无法取得本机操作授权，请刷新后重试。');
        const payload = await api(`/api/runtime-release/${action}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'X-Ajun-Owner-Action': nonce,
                'X-Ajun-Console-Origin': location.origin,
            },
            body: JSON.stringify(body),
        });
        render(payload.status);
        disconnectedDuringAction = action !== 'check';
        schedulePoll(500);
    }
    checkButton.addEventListener('click', async () => {
        try {
            await post('check');
        }
        catch (error) {
            message.textContent = error.message;
        }
    });
    publishButton.addEventListener('click', async () => {
        if (!confirmAction('发布 main 当前已提交版本？系统会完整检查，失败会自动恢复旧版。'))
            return;
        try {
            await post('publish', { confirm: 'publish_current_commit' });
        }
        catch (error) {
            message.textContent = error.message;
        }
    });
    rollbackButton.addEventListener('click', async () => {
        if (!confirmAction('退回上一版？系统会重启 A君 并确认恢复成功。'))
            return;
        try {
            await post('rollback', { confirm: 'rollback_previous_release' });
        }
        catch (error) {
            message.textContent = error.message;
        }
    });
    return {
        activate() {
            active = true;
            refresh();
        },
        deactivate() {
            active = false;
            clearTimeout(timer);
        },
    };
}
