import { escapeHtml } from './html.js';

export function showToast(message: string, duration = 2200): void {
    let container = document.querySelector('.workbench-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'workbench-toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'workbench-toast success';
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('is-visible');
    });

    setTimeout(() => {
        toast.classList.remove('is-visible');
        setTimeout(() => {
            toast.remove();
            if (container && container.children.length === 0) {
                container.remove();
            }
        }, 250);
    }, duration);
}

export async function copyToClipboard(text: string): Promise<boolean> {
    if (!text) return false;
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // fallback below
        }
    }
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-999999px';
        textarea.style.top = '-999999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        return successful;
    } catch {
        return false;
    }
}

export function bindDetailInteractions(options: {
    elements: any;
    state: any;
    task: any;
    renderDetail: () => void;
    replaceRecordUrl: () => void;
    loadSelectedDetail: (opts: any) => Promise<void>;
    api?: any;
    loadRecords?: () => Promise<void>;
}): void {
    const { elements, state, task, renderDetail, replaceRecordUrl, loadSelectedDetail, api, loadRecords } = options;

    for (const closeBtn of elements.detail.querySelectorAll('[data-subtask-drawer-close]')) {
        closeBtn.addEventListener('click', (): any => {
            state.previewSubtaskData = null;
            renderDetail();
        });
    }
    elements.detail.querySelector('[data-subtask-drawer-overlay]')?.addEventListener('click', (e: any): any => {
        if (e.target === e.currentTarget) {
            state.previewSubtaskData = null;
            renderDetail();
        }
    });

    elements.detail.querySelector('.record-detail-back')?.addEventListener('click', (): any => {
        elements.workbench.classList.remove('is-detail-open');
        replaceRecordUrl();
    });

    for (const toggleHeader of elements.detail.querySelectorAll('[data-artifact-toggle]')) {
        toggleHeader.addEventListener('click', async (event: any): Promise<any> => {
            if (event.target.closest('.artifact-micro-btn, a, button')) {
                return;
            }
            const item = toggleHeader.closest('.record-artifact-item');
            if (!item) return;
            const targetPath = item.dataset.filePath;
            const container = item.querySelector('.artifact-dynamic-preview');
            const inlinePreview = item.querySelector('.artifact-inline-preview');

            // If it already has inline preview without dynamic file fetching
            if (inlinePreview && !targetPath) {
                item.classList.toggle('is-collapsed');
                return;
            }

            if (targetPath && container) {
                // If content is already fetched, simply toggle visibility
                if (container.dataset.loadedPath === targetPath && container.innerHTML.trim() !== '') {
                    const isCollapsed = item.classList.contains('is-collapsed');
                    if (isCollapsed) {
                        item.classList.remove('is-collapsed');
                        container.style.display = 'block';
                    } else {
                        item.classList.add('is-collapsed');
                        container.style.display = 'none';
                    }
                    return;
                }

                // Show loading spinner
                container.innerHTML = `<div style="padding: 10px 12px; font-size: 12.5px; color: var(--muted); display: flex; align-items: center; gap: 8px;"><svg class="animate-spin" width="14" height="14" aria-hidden="true"><use href="#icon-sync"></use></svg> 正在加载产物内容...</div>`;
                container.style.display = 'block';
                item.classList.remove('is-collapsed');

                try {
                    let fetchUrl = String(targetPath || '').trim();
                    if (fetchUrl.startsWith('"') && fetchUrl.endsWith('"')) {
                        fetchUrl = fetchUrl.slice(1, -1).trim();
                    }
                    if (fetchUrl.startsWith("'") && fetchUrl.endsWith("'")) {
                        fetchUrl = fetchUrl.slice(1, -1).trim();
                    }
                    if (fetchUrl.startsWith('file:')) {
                        fetchUrl = fetchUrl.replace(/^file:\/+/i, '/');
                    }
                    const res = await fetch(`/api/artifacts/content?path=${encodeURIComponent(fetchUrl)}`);
                    if (!res.ok) {
                        const errJson = await res.json().catch(() => ({}));
                        throw new Error(errJson.error || `HTTP ${res.status}`);
                    }
                    const data = await res.json();
                    container.dataset.loadedPath = targetPath;

                    if (data.isImage) {
                        container.innerHTML = `
                            <div class="artifact-preview-image-box" style="padding: 12px; background: rgba(0,0,0,0.03); border-radius: 8px; margin-top: 8px;">
                                <img src="${data.dataUrl}" alt="${data.filename || '产物预览'}" class="artifact-preview-img" style="max-width: 100%; border-radius: 6px; display: block;" />
                            </div>`;
                    } else if (data.isJson) {
                        let formatted = data.content;
                        try {
                            const parsed = JSON.parse(data.content);
                            formatted = JSON.stringify(parsed, null, 2);
                        } catch {}
                        container.innerHTML = `
                            <div class="artifact-inline-preview">
                                <div class="artifact-preview-body">
                                    <pre class="artifact-preview-text">${escapeHtml(formatted)}</pre>
                                </div>
                            </div>`;
                    } else {
                        container.innerHTML = `
                            <div class="artifact-inline-preview">
                                <div class="artifact-preview-body">
                                    <pre class="artifact-preview-text">${escapeHtml(data.content)}</pre>
                                </div>
                            </div>`;
                    }
                    container.style.display = 'block';
                    item.classList.remove('is-collapsed');
                } catch (err: any) {
                    container.innerHTML = `
                        <div class="artifact-inline-preview" style="border-left: 3px solid var(--amber);">
                            <div class="artifact-preview-body" style="padding: 10px 14px;">
                                <p style="margin: 0 0 6px 0; font-size: 12.5px; color: var(--ink-soft); font-weight: 600;">暂无法直接预览文件正文（${escapeHtml(err.message || '读取失败')}）</p>
                                <p style="margin: 0; font-size: 11.5px; color: var(--muted); font-family: var(--mono); word-break: break-all;">受控路径：${escapeHtml(targetPath)}</p>
                            </div>
                        </div>`;
                    container.dataset.loadedPath = targetPath;
                    container.style.display = 'block';
                    item.classList.remove('is-collapsed');
                }
            }
        });
    }

    for (const copyBtn of elements.detail.querySelectorAll('[data-copy-path]')) {
        copyBtn.addEventListener('click', async (event: any): Promise<any> => {
            event.stopPropagation();
            let path = String(event.currentTarget.dataset.copyPath || '').trim();
            if (!path) return;
            if (path.startsWith('"') && path.endsWith('"')) {
                path = path.slice(1, -1).trim();
            }
            if (path.startsWith("'") && path.endsWith("'")) {
                path = path.slice(1, -1).trim();
            }
            if (path.startsWith('file:')) {
                path = path.replace(/^file:\/+/i, '/');
            }
            const ok = await copyToClipboard(path);
            const btn = event.currentTarget;
            const span = btn.querySelector('span');
            const originalText = span ? span.textContent : btn.textContent;
            if (ok) {
                btn.classList.add('copied');
                if (span) span.textContent = '已复制 ✨';
                else btn.textContent = '已复制 ✨';
                showToast('🔗 路径已复制到剪贴板');
                setTimeout(() => {
                    if (btn && btn.isConnected) {
                        btn.classList.remove('copied');
                        if (span) span.textContent = originalText;
                        else btn.textContent = originalText;
                    }
                }, 2000);
            }
        });
    }

    for (const copyTextBtn of elements.detail.querySelectorAll('[data-copy-text]')) {
        copyTextBtn.addEventListener('click', async (event: any): Promise<any> => {
            event.stopPropagation();
            const text = event.currentTarget.dataset.copyText;
            if (!text) return;
            const ok = await copyToClipboard(text);
            const btn = event.currentTarget;
            const span = btn.querySelector('span');
            const originalText = span ? span.textContent : btn.textContent;
            if (ok) {
                btn.classList.add('copied');
                if (span) span.textContent = '已复制 ✨';
                else btn.textContent = '已复制 ✨';
                showToast('📋 内容已复制到剪贴板');
                setTimeout(() => {
                    if (btn && btn.isConnected) {
                        btn.classList.remove('copied');
                        if (span) span.textContent = originalText;
                        else btn.textContent = originalText;
                    }
                }, 2000);
            }
        });
    }

    for (const switchBtn of elements.detail.querySelectorAll('.tree-switch-btn')) {
        switchBtn.addEventListener('click', async (): Promise<any> => {
            const targetId: any = switchBtn.dataset.recordTaskId;
            if (targetId && targetId !== state.selectedTaskId) {
                state.selectedTaskId = targetId;
                state.selectedTask = null;
                state.previewSubtaskData = null;
                state.detailTab = 'overview';
                state.selectedDetailLoaded = false;
                await loadSelectedDetail({ revealDetail: true });
            }
        });
    }

    elements.detail.querySelector('.record-copy-id')?.addEventListener('click', async (event: any): Promise<any> => {
        const ok = await copyToClipboard(task.taskId);
        const button: any = event.currentTarget;
        if (button && ok) {
            button.classList.add('copied');
            button.textContent = '已复制 ✨';
            showToast('📋 任务编号已复制');
            setTimeout(() => {
                if (button && button.isConnected) {
                    button.classList.remove('copied');
                    button.textContent = '复制编号';
                }
            }, 2000);
        }
    });

    // Pipeline red node → recovery popover
    for (const actionNode of elements.detail.querySelectorAll('[data-pipeline-action]')) {
        actionNode.addEventListener('click', (event: any): void => {
            event.stopPropagation();
            // Remove any existing popover
            const existing = elements.detail.querySelector('.pipeline-action-popover');
            if (existing) { existing.remove(); return; }
            const cause = actionNode.dataset.pipelineCause || '任务中断';
            const actionKey = actionNode.dataset.pipelineActionKey || '';
            const actionLabel = actionNode.dataset.pipelineActionLabel || '继续';
            const popover = document.createElement('div');
            popover.className = 'pipeline-action-popover';
            popover.innerHTML = `<p class="pipeline-popover-cause">${escapeHtml(cause)}</p><button type="button" class="pipeline-popover-action" data-attention-action="${escapeHtml(actionKey)}">▶ ${escapeHtml(actionLabel)}</button>`;
            actionNode.style.position = 'relative';
            actionNode.appendChild(popover);
            // Close on outside click
            const dismiss = (e: any): void => {
                if (!popover.contains(e.target) && e.target !== actionNode && !actionNode.contains(e.target)) {
                    popover.remove();
                    document.removeEventListener('click', dismiss, true);
                }
            };
            setTimeout(() => document.addEventListener('click', dismiss, true), 0);
        });
    }

    // "需改进" → show revision input instead of immediately submitting
    elements.detail.querySelector('[data-acceptance-show-revision]')?.addEventListener('click', (): void => {
        state.acceptanceState.set(task.taskId, { status: 'revision_input' });
        renderDetail();
        setTimeout(() => {
            const input = elements.detail.querySelector('.acceptance-revision-input input');
            if (input) input.focus();
        }, 50);
    });

    // Provide missing input for needs_input task
    const submitNeedsInput = async (): Promise<void> => {
        const inputEl: HTMLInputElement | null = elements.detail.querySelector(`[data-task-needs-input="${task.taskId}"]`);
        const submitBtn: HTMLButtonElement | null = elements.detail.querySelector(`[data-task-submit-input="${task.taskId}"]`);
        const content = String(inputEl?.value || '').trim();
        if (!content) {
            showToast('⚠️ 请先输入素材链接或补充内容');
            inputEl?.focus();
            return;
        }
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '提交中…';
        }
        try {
            if (api) {
                await api(`/api/tasks/${encodeURIComponent(task.taskId)}/provide-input`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ input: content }),
                });
            } else {
                await fetch(`/api/tasks/${encodeURIComponent(task.taskId)}/provide-input`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ input: content }),
                });
            }
            showToast('✅ 补充信息已提交，任务正在接续执行！');
            if (loadRecords) await loadRecords();
            await loadSelectedDetail({ revealDetail: true });
        } catch (err: any) {
            showToast(`❌ 提交失败: ${err?.message || '请稍后重试'}`);
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '提交并继续';
            }
        }
    };

    elements.detail.querySelector(`[data-task-submit-input="${task.taskId}"]`)?.addEventListener('click', submitNeedsInput);
    elements.detail.querySelector(`[data-task-needs-input="${task.taskId}"]`)?.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitNeedsInput();
        }
    });
}
