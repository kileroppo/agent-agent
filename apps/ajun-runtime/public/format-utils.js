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
