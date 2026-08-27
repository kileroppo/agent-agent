export function formatNumber(value) {
    return Number(value || 0).toLocaleString('zh-CN');
}
export function formatCompactNumber(value) {
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
}
export function formatUsd(value) {
    const number = Number(value || 0);
    return `$${number.toFixed(number >= 0.01 ? 2 : 4)}`;
}
export function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '待确认' : date.toLocaleString();
}
export function providerLabel(provider) {
    return {
        xhs: '小红书',
        dy: '抖音',
        bili: '哔哩哔哩',
        ks: '快手',
        youtube: 'YouTube'
    }[provider] || provider || '未知平台';
}
export function formatFullDateTime(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp))
        return '';
    const date = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}
export function formatDuration(start, end) {
    const startTime = Date.parse(start || '');
    const endTime = end ? Date.parse(end) : Date.now();
    if (!Number.isFinite(startTime))
        return '';
    const diffMs = Math.max(0, endTime - startTime);
    if (diffMs < 1000)
        return `${diffMs} ms`;
    if (diffMs < 60000)
        return `${(diffMs / 1000).toFixed(1)} 秒`;
    if (diffMs < 3600000)
        return `${Math.floor(diffMs / 60000)} 分 ${Math.round((diffMs % 60000) / 1000)} 秒`;
    return `${(diffMs / 3600000).toFixed(1)} 小时`;
}
export function isValidHttpUrl(value) {
    const text = String(value || '').trim();
    if (!text)
        return false;
    try {
        const url = new URL(text);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}
