export function bindAccessGateInteractions({ elements, state, api, load }) {
    const { accessForm, accessKey, collaboratorName, rotateShareKey, shareMessage } = elements;
    accessForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        state.shareKey = accessKey.value.trim();
        state.requesterName = collaboratorName.value.trim();
        sessionStorage.setItem('ajun-share-key', state.shareKey);
        sessionStorage.setItem('ajun-requester-name', state.requesterName);
        await load();
    });
    rotateShareKey.addEventListener('click', async () => {
        if (!window.confirm('换新后，旧口令会立即失效。确定继续吗？'))
            return;
        rotateShareKey.disabled = true;
        try {
            const share = await api('/api/local-share/rotate', { method: 'POST' });
            const shareKey = document.querySelector('#share-key');
            shareKey.value = share.accessKey;
            shareMessage.textContent = '已换新，请把新口令发给需要继续访问的人。';
        }
        catch (error) {
            shareMessage.textContent = error.message;
        }
        finally {
            rotateShareKey.disabled = false;
        }
    });
}
