export function parseSeconds(ts: any): number | null {
    if (!ts || typeof ts !== 'string') return null;
    const parts = ts.trim().split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
}

export function timestampNearTimeline(timestamp: string, timeline: Set<string>, toleranceSec = 5): boolean {
    if (timeline.has(timestamp)) return true;
    const targetSec = parseSeconds(timestamp);
    if (targetSec === null) return false;
    for (const entry of timeline) {
        const entrySec = parseSeconds(entry);
        if (entrySec !== null && Math.abs(entrySec - targetSec) <= toleranceSec) {
            return true;
        }
    }
    return false;
}

export function fuzzyTextMatches(source: string, target: string, minRatio = 0.60): boolean {
    if (!source || !target) return false;
    if (source.includes(target)) return true;
    if (target.length < 4) return false;

    const chunkLen = Math.min(8, Math.max(4, Math.floor(target.length * 0.5)));
    let hasAnchor = false;
    for (let i = 0; i <= target.length - chunkLen; i += 2) {
        const sub = target.slice(i, i + chunkLen);
        if (source.includes(sub)) {
            hasAnchor = true;
            break;
        }
    }
    if (!hasAnchor && target.length > 10) return false;

    let matchedChars = 0;
    let sourceIdx = 0;
    for (let i = 0; i < target.length; i++) {
        const ch = target[i];
        const found = source.indexOf(ch, sourceIdx);
        if (found !== -1) {
            matchedChars++;
            sourceIdx = found + 1;
        }
    }
    return (matchedChars / target.length) >= minRatio;
}
