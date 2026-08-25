export function formatNumber(value: any): any {
    return Number(value || 0).toLocaleString('zh-CN');
}
export function formatCompactNumber(value: any): any {
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
}
export function formatUsd(value: any): any {
    const number: any = Number(value || 0);
    return `$${number.toFixed(number >= 0.01 ? 2 : 4)}`;
}
export function formatDate(value: any): any {
    const date: any = new Date(value);
    return Number.isNaN(date.getTime()) ? '待确认' : date.toLocaleString();
}
export function providerLabel(provider: any): any {
    return ({
        xhs: '小红书',
        dy: '抖音',
        bili: '哔哩哔哩',
        ks: '快手',
        youtube: 'YouTube'
    } as Record<string, string>)[provider] || provider || '未知平台';
}
