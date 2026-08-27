import { escapeHtml } from './html.js';

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
}): void {
    const { elements, state, task, renderDetail, replaceRecordUrl, loadSelectedDetail } = options;

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

            if (inlinePreview) {
                inlinePreview.classList.toggle('is-hidden');
                item.classList.toggle('is-collapsed');
                return;
            }

            if (targetPath && container) {
                if (container.style.display !== 'none' && container.dataset.loadedPath === targetPath) {
                    container.style.display = 'none';
                    item.classList.add('is-collapsed');
                    return;
                }
                try {
                    const res = await fetch(`/api/artifacts/content?path=${encodeURIComponent(targetPath)}`);
                    if (!res.ok) {
                        const errJson = await res.json().catch(() => ({}));
                        throw new Error(errJson.error || '无法读取文件内容');
                    }
                    const data = await res.json();
                    container.dataset.loadedPath = targetPath;
                    if (data.isImage) {
                        container.innerHTML = `<div class="artifact-preview-image-box" style="padding: 12px; background: rgba(0,0,0,0.03); border-radius: 8px; margin-top: 8px;"><img src="${data.dataUrl}" alt="${data.filename || '产物预览'}" class="artifact-preview-img" style="max-width: 100%; border-radius: 6px; display: block;" /></div>`;
                    } else if (data.isJson) {
                        let formatted = data.content;
                        try { formatted = JSON.stringify(JSON.parse(data.content), null, 2); } catch {}
                        container.innerHTML = `<div class="artifact-inline-preview"><div class="artifact-preview-body"><pre class="artifact-preview-text">${escapeHtml(formatted)}</pre></div></div>`;
                    } else {
                        container.innerHTML = `<div class="artifact-inline-preview"><div class="artifact-preview-body"><pre class="artifact-preview-text">${escapeHtml(data.content)}</pre></div></div>`;
                    }
                    container.style.display = 'block';
                    item.classList.remove('is-collapsed');
                } catch (err: any) {
                    container.innerHTML = `<div class="artifact-inline-preview" style="border-left: 3px solid var(--muted);"><div class="artifact-preview-body"><p style="margin: 0; font-size: 12.5px; color: var(--muted);">本地受控文件路径：<code>${escapeHtml(targetPath)}</code></p></div></div>`;
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
            let path = event.currentTarget.dataset.copyPath;
            if (!path) return;
            if (path.startsWith('file://')) {
                try {
                    path = decodeURIComponent(new URL(path).pathname);
                } catch {
                    path = path.replace(/^file:\/\//, '');
                }
            }
            const ok = await copyToClipboard(path);
            const span = event.currentTarget.querySelector('span');
            const originalText = span ? span.textContent : event.currentTarget.textContent;
            if (ok) {
                if (span) span.textContent = '已复制';
                else event.currentTarget.textContent = '已复制';
                setTimeout(() => {
                    if (event.currentTarget && event.currentTarget.isConnected) {
                        if (span) span.textContent = originalText;
                        else event.currentTarget.textContent = originalText;
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
            const span = event.currentTarget.querySelector('span');
            const originalText = span ? span.textContent : event.currentTarget.textContent;
            if (ok) {
                if (span) span.textContent = '已复制';
                else event.currentTarget.textContent = '已复制';
                setTimeout(() => {
                    if (event.currentTarget && event.currentTarget.isConnected) {
                        if (span) span.textContent = originalText;
                        else event.currentTarget.textContent = originalText;
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
        try {
            await navigator.clipboard.writeText(task.taskId);
            const button: any = event.currentTarget;
            if (button) {
                button.textContent = '已复制';
                setTimeout(() => {
                    if (button && button.isConnected && button.textContent === '已复制') {
                        button.textContent = '复制编号';
                    }
                }, 2000);
            }
        } catch {
            event.currentTarget.textContent = '复制失败';
        }
    });
}
