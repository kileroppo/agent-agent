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

export function releaseActionAvailability(status: any): any {
  const active = ACTIVE_STATES.has(status?.state);
  return {
    checking:active,
    canPublish:status?.state === 'ready' && status?.candidate?.clean === true,
    canRollback:!active && Boolean(status?.rollback?.releaseHash),
  };
}

export function releaseStageView(status: any): any {
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
    state:terminalComplete || (activeIndex >= 0 && index < activeIndex)
      ? 'done'
      : index === activeIndex ? 'active' : 'pending',
  }));
}

export function createRuntimeReleaseConsole({ root, api, confirmAction = window.confirm.bind(window) }: any): any {
  if (!root) return { activate() {} };
  const current = root.querySelector('#release-current');
  const candidate = root.querySelector('#release-candidate');
  const rollback = root.querySelector('#release-rollback');
  const message = root.querySelector('#release-message');
  const stages = root.querySelector('#release-stages');
  const checkButton = root.querySelector('#release-check');
  const publishButton = root.querySelector('#release-publish');
  const rollbackButton = root.querySelector('#release-rollback-action');
  const historyList = root.querySelector('#release-history-list');
  const historySummary = root.querySelector('#release-history-summary');
  const componentStatus = root.querySelector('#release-component-status');
  let status: any = null;
  let timer: any = null;
  let active = false;
  let disconnectedDuringAction = false;
  let helperOnline = false;
  let wasActive = false;

  function shortHash(value: any): any {
    const text = String(value || '').trim();
    return text ? text.slice(0, 8) : '未知';
  }

  function candidateTruth(value: any): string {
    if (!value?.gitHead) return '先检查新版';
    const validation = ({
      not_checked:'未验证', running:'验证中', passed:'已通过验证', not_completed:'验证未完成',
    } as Record<string, string>)[value.validation?.status] || '未验证';
    return `${shortHash(value.gitHead)} · ${value.committed ? '已提交' : '提交未知'} · ${validation} · ${value.publishable ? '可发布' : '不可发布'} · ${value.undeployed ? '尚未部署' : '已在运行'}`;
  }

  function liveTruth(value: any): string {
    if (!value?.releaseHash) return '尚未读取';
    const checks = value.verification?.checks || {};
    const verified = ['pid', 'cwd', 'argv', 'releaseHash', 'payloadHash', 'gitHead', 'api'].every((name) => checks[name] === true);
    return `线上 · ${shortHash(value.releaseHash)} · ${verified ? '运行身份已核对' : '运行身份未核对'}`;
  }

  function render(next: any): any {
    status = next;
    const actions = releaseActionAvailability(status);
    current.textContent = liveTruth(status?.current);
    candidate.textContent = candidateTruth(status?.candidate);
    rollback.textContent = status?.rollback?.releaseHash
      ? `可退回 · ${shortHash(status.rollback.releaseHash)}`
      : '暂无可退回版本';
    message.textContent = status?.message || '尚未检查新版。';
    message.dataset.state = status?.state || 'idle';
    stages.replaceChildren(...releaseStageView(status).map((item: any): any => {
      const li = document.createElement('li');
      li.className = `release-stage is-${item.state}`;
      if (item.state === 'active') li.setAttribute('aria-current', 'step');
      li.innerHTML = `<span class="release-stage-symbol" aria-hidden="true">${item.state === 'done' ? '✓' : ''}</span><strong>${item.label}</strong>${item.state === 'active' ? '<span class="release-stage-live"><i aria-hidden="true"></i>进行中</span>' : ''}`;
      return li;
    }));
    checkButton.disabled = actions.checking;
    publishButton.disabled = !actions.canPublish;
    rollbackButton.disabled = !actions.canRollback;
    const nowActive = ACTIVE_STATES.has(status?.state);
    // 发布或回滚跑完后，历史清单里的“运行中/回滚目标”标记会变化，需要重新读取。
    if (wasActive && !nowActive) loadHistory();
    wasActive = nowActive;
  }

  const PROTECTION_LABELS: any = { live:'运行中', rollback:'回滚目标' };
  const PRODUCT_LABELS: any = { ajun:'A君' };

  function renderHistory(releases: any[]): any {
    historySummary.textContent = helperOnline
      ? `共 ${releases.length} 个版本快照；运行中和回滚目标不可删除。`
      : `共 ${releases.length} 个版本快照；发布助手离线，暂不能核对运行中版本，删除已停用。`;
    historyList.replaceChildren(...releases.map((release: any): any => {
      const li = document.createElement('li');
      li.className = 'release-history-item';
      const date = release.createdAt
        ? new Date(release.createdAt).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
        : '时间未知';
      const meta = document.createElement('span');
      meta.className = 'release-history-meta';
      meta.textContent = `${PRODUCT_LABELS[release.product] || 'A君'} · ${date}${release.gitHead ? ` · 提交 ${shortHash(release.gitHead)}` : ''}`;
      const id = document.createElement('code');
      id.className = 'release-history-id';
      id.textContent = shortHash(release.releaseHash);
      li.append(id, meta);
      const protection = PROTECTION_LABELS[release.protection];
      if (protection) {
        const badge = document.createElement('span');
        badge.className = 'release-history-protected';
        badge.textContent = protection;
        li.appendChild(badge);
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary-action danger-action';
        button.textContent = '删除';
        button.disabled = !helperOnline;
        if (!helperOnline) button.title = '发布助手离线，无法确认运行中版本，删除已停用。';
        button.addEventListener('click', () => deleteRelease(release.releaseHash, button).catch((error: any): any => { message.textContent = error.message; }));
        li.appendChild(button);
      }
      return li;
    }));
  }

  async function loadHistory(): Promise<any> {
    if (!active) return;
    try {
      const payload = await api('/api/runtime-release/listing');
      helperOnline = payload?.helperOnline === true;
      renderHistory(payload?.releases || []);
      const xiaod = payload?.components?.xiaod;
      componentStatus.textContent = xiaod?.releaseHash
        ? `小D是独立运行组件，当前版本 ${shortHash(xiaod.releaseHash)} 已受保护；不在这里发布、回滚或清理。`
        : '小D是独立运行组件；当前未读取到它的运行版本，不影响 A君版本管理。';
    } catch (error: any) {
      historySummary.textContent = error.message || '暂时无法读取版本库。';
      historyList.replaceChildren();
      componentStatus.textContent = '暂时无法读取小D运行组件状态。';
    }
  }

  async function deleteRelease(releaseHash: any, triggerButton: any): Promise<any> {
    if (triggerButton?.disabled) return;
    if (!confirmAction(`删除版本 ${shortHash(releaseHash)}？删除后无法恢复，但不会影响正在运行的版本。`)) return;
    const session = await api('/api/owner-action-session');
    const nonce = String(session?.nonce || '').trim();
    if (!nonce) throw new Error('暂时无法取得本机操作授权，请刷新后重试。');
    triggerButton.disabled = true;
    triggerButton.textContent = '正在删除…';
    try {
      await api('/api/runtime-release/delete', {
        method:'POST',
        headers:{
          'content-type':'application/json',
          'X-Ajun-Owner-Action':nonce,
          'X-Ajun-Console-Origin':location.origin,
        },
        body:JSON.stringify({ releaseHash, confirm:'delete_release_snapshot' }),
      });
      message.textContent = '已删除该版本快照。';
      await loadHistory();
    } finally {
      if (triggerButton?.isConnected) {
        triggerButton.disabled = false;
        triggerButton.textContent = '删除';
      }
    }
  }

  function schedulePoll(delay = 1500): any {
    clearTimeout(timer);
    if (!active) return;
    timer = setTimeout(refresh, delay);
  }

  async function refresh(): Promise<any> {
    try {
      const payload = await api('/api/runtime-release/status');
      disconnectedDuringAction = false;
      render(payload.status);
      if (ACTIVE_STATES.has(payload.status?.state)) schedulePoll();
    } catch (error: any) {
      if (ACTIVE_STATES.has(status?.state) || disconnectedDuringAction) {
        disconnectedDuringAction = true;
        message.textContent = 'A君正在重启，等待重新连接…';
        schedulePoll(1800);
        return;
      }
      message.textContent = error.message || '暂时无法读取版本状态。';
    }
  }

  async function post(action: any, body: any = {}): Promise<any> {
    const session = await api('/api/owner-action-session');
    const nonce = String(session?.nonce || '').trim();
    if (!nonce) throw new Error('暂时无法取得本机操作授权，请刷新后重试。');
    const payload = await api(`/api/runtime-release/${action}`, {
      method:'POST',
      headers:{
        'content-type':'application/json',
        'X-Ajun-Owner-Action':nonce,
        'X-Ajun-Console-Origin':location.origin,
      },
      body:JSON.stringify(body),
    });
    render(payload.status);
    disconnectedDuringAction = action !== 'check';
    schedulePoll(500);
  }

  checkButton.addEventListener('click', async () => {
    try { await post('check'); } catch (error: any) { message.textContent = error.message; }
  });
  publishButton.addEventListener('click', async () => {
    if (!confirmAction('发布 main 当前已提交版本？系统会完整检查，失败会自动恢复旧版。')) return;
    try { await post('publish', { confirm:'publish_current_commit' }); } catch (error: any) { message.textContent = error.message; }
  });
  rollbackButton.addEventListener('click', async () => {
    if (!confirmAction('退回上一版？系统会重启 A君 并确认恢复成功。')) return;
    try { await post('rollback', { confirm:'rollback_previous_release' }); } catch (error: any) { message.textContent = error.message; }
  });

  return {
    activate(): any {
      active = true;
      refresh();
      loadHistory();
    },
    deactivate(): any {
      active = false;
      clearTimeout(timer);
    },
  };
}
