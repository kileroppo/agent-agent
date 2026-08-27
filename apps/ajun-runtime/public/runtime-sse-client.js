export function startRuntimeSseClient(options = {}) {
    const { url = '/api/events/stream', onTaskUpdate, onLogChunk, onConnected, onError, } = options;
    if (typeof globalThis.EventSource !== 'function') {
        return { stop: () => { }, isConnected: () => false };
    }
    let source = null;
    let stopped = false;
    let connected = false;
    let retryTimer = null;
    function connect() {
        if (stopped)
            return;
        try {
            source = new globalThis.EventSource(url);
            source.onopen = () => {
                connected = true;
                onConnected?.();
            };
            source.addEventListener('task_update', (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    onTaskUpdate?.(payload);
                }
                catch {
                    // ignore parsing error
                }
            });
            source.addEventListener('log_chunk', (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    onLogChunk?.(payload);
                }
                catch {
                    // ignore parsing error
                }
            });
            source.onerror = (err) => {
                connected = false;
                onError?.(err);
                source?.close();
                source = null;
                if (!stopped) {
                    clearTimeout(retryTimer);
                    retryTimer = setTimeout(connect, 3000);
                }
            };
        }
        catch (err) {
            connected = false;
            onError?.(err);
            if (!stopped) {
                clearTimeout(retryTimer);
                retryTimer = setTimeout(connect, 5000);
            }
        }
    }
    connect();
    return {
        stop() {
            stopped = true;
            connected = false;
            clearTimeout(retryTimer);
            source?.close();
            source = null;
        },
        isConnected() {
            return connected;
        },
    };
}
