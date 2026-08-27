import { escapeHtml } from './html.js';
export function bindDetailInteractions(options) {
    const { elements, state, task, renderDetail, replaceRecordUrl, loadSelectedDetail } = options;
    for (const closeBtn of elements.detail.querySelectorAll('[data-subtask-drawer-close]')) {
        closeBtn.addEventListener('click', () => {
            state.previewSubtaskData = null;
            renderDetail();
        });
    }
    elements.detail.querySelector('[data-subtask-drawer-overlay]')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            state.previewSubtaskData = null;
            renderDetail();
        }
    });
    elements.detail.querySelector('.record-detail-back')?.addEventListener('click', () => {
        elements.workbench.classList.remove('is-detail-open');
        replaceRecordUrl();
    });
    for (const toggleHeader of elements.detail.querySelectorAll('[data-artifact-toggle]')) {
        toggleHeader.addEventListener('click', async (event) => {
            if (event.target.closest('.artifact-micro-btn, a, button')) {
                return;
            }
            const item = toggleHeader.closest('.record-artifact-item');
            if (!item)
                return;
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
                    if (!res.ok)
                        throw new Error('无法读取文件内容');
                    const data = await res.json();
                    container.dataset.loadedPath = targetPath;
                    if (data.isImage) {
                        container.innerHTML = `<div class="artifact-preview-image-box" style="padding: 12px; background: rgba(0,0,0,0.03); border-radius: 8px; margin-top: 8px;"><img src="${data.dataUrl}" alt="${data.filename || '产物预览'}" class="artifact-preview-img" style="max-width: 100%; border-radius: 6px; display: block;" /></div>`;
                    }
                    else if (data.isJson) {
                        let formatted = data.content;
                        try {
                            formatted = JSON.stringify(JSON.parse(data.content), null, 2);
                        }
                        catch { }
                        container.innerHTML = `<div class="artifact-inline-preview"><div class="artifact-preview-body"><pre class="artifact-preview-text">${escapeHtml(formatted)}</pre></div></div>`;
                    }
                    else {
                        container.innerHTML = `<div class="artifact-inline-preview"><div class="artifact-preview-body"><pre class="artifact-preview-text">${escapeHtml(data.content)}</pre></div></div>`;
                    }
                    container.style.display = 'block';
                    item.classList.remove('is-collapsed');
                }
                catch (err) {
                    alert(err?.message || '读取产物内容失败');
                }
            }
        });
    }
    for (const copyBtn of elements.detail.querySelectorAll('[data-copy-path]')) {
        copyBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            const path = event.currentTarget.dataset.copyPath;
            if (!path)
                return;
            try {
                await navigator.clipboard.writeText(path);
                const span = event.currentTarget.querySelector('span');
                const originalText = span ? span.textContent : event.currentTarget.textContent;
                if (span)
                    span.textContent = '已复制';
                else
                    event.currentTarget.textContent = '已复制';
                setTimeout(() => {
                    if (event.currentTarget && event.currentTarget.isConnected) {
                        if (span)
                            span.textContent = originalText;
                        else
                            event.currentTarget.textContent = originalText;
                    }
                }, 2000);
            }
            catch {
                alert('复制路径失败');
            }
        });
    }
    for (const copyTextBtn of elements.detail.querySelectorAll('[data-copy-text]')) {
        copyTextBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            const text = event.currentTarget.dataset.copyText;
            if (!text)
                return;
            try {
                await navigator.clipboard.writeText(text);
                const span = event.currentTarget.querySelector('span');
                const originalText = span ? span.textContent : event.currentTarget.textContent;
                if (span)
                    span.textContent = '已复制';
                else
                    event.currentTarget.textContent = '已复制';
                setTimeout(() => {
                    if (event.currentTarget && event.currentTarget.isConnected) {
                        if (span)
                            span.textContent = originalText;
                        else
                            event.currentTarget.textContent = originalText;
                    }
                }, 2000);
            }
            catch {
                alert('复制内容失败');
            }
        });
    }
    for (const switchBtn of elements.detail.querySelectorAll('.tree-switch-btn')) {
        switchBtn.addEventListener('click', async () => {
            const targetId = switchBtn.dataset.recordTaskId;
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
    elements.detail.querySelector('.record-copy-id')?.addEventListener('click', async (event) => {
        try {
            await navigator.clipboard.writeText(task.taskId);
            const button = event.currentTarget;
            if (button) {
                button.textContent = '已复制';
                setTimeout(() => {
                    if (button && button.isConnected && button.textContent === '已复制') {
                        button.textContent = '复制编号';
                    }
                }, 2000);
            }
        }
        catch {
            event.currentTarget.textContent = '复制失败';
        }
    });
}
