import { fuzzyTextMatches, timestampNearTimeline } from './local-content-evidence-matcher.ts';

export function evidenceSegments(transcript: any): any {
    const body: any = String(transcript || '').replace(/^---[\s\S]*?---\s*/m, '').replace(/^#\s+[^\n]+\n+/m, '');
    const timed: any = [...body.matchAll(/\[((?:\d{2}:)?\d{2}:\d{2})\]\s*([^\n]+)/g)]
        .map((match: any): any => ({ timestamp: match[1], text: clean(match[2], 500) }));
    if (timed.length)
        return groupEvidenceSegments(timed);
    const untimed: any = body.split(/\n+/).map((line: any): any => clean(line, 500))
        .filter((line: any): any => line.length >= 8).map((text: any): any => ({ timestamp: null, text }));
    return groupEvidenceSegments(untimed);
}

function groupEvidenceSegments(segments: any, maxBlocks: any = 30): any {
    if (segments.length <= maxBlocks)
        return segments;
    const groupSize: any = Math.ceil(segments.length / maxBlocks);
    const grouped: any[] = [];
    for (let index: any = 0; index < segments.length; index += groupSize) {
        const group: any = segments.slice(index, index + groupSize);
        grouped.push({ timestamp: group[0]?.timestamp || null,
            text: clean(group.map((item: any): any => item.text).join(' '), 2000) });
    }
    return grouped;
}

export function validSentenceBreakdown(value: any, transcript: any, { requireCoverage }: any): any {
    const breakdown: any = Array.isArray(value) ? value : [];
    if (!breakdown.length || !breakdown.every((item: any): any => evidenceMatches(transcript, breakdownEvidence(item))))
        return false;
    if (!requireCoverage)
        return true;
    const covered: any = breakdown.map((item: any): any => evidenceText(breakdownEvidence(item)?.fragment)).join('');
    return evidenceSegments(transcript).every((segment: any): any => covered.includes(evidenceText(segment.text)));
}

export function evidenceLinkedItems(value: any, transcript: any): any {
    return Array.isArray(value) && value.length > 0
        && value.every((item: any): any => evidenceMatches(transcript, item?.evidence));
}

export function evidenceMatches(transcript: any, evidence: any): any {
    const fragment: any = clean(evidence?.fragment, 500);
    if (!fragment || evidenceText(fragment).length < 4)
        return false;
    const segments: any = evidenceSegments(transcript);
    const transcriptText: any = evidenceText(segments.map((segment: any): any => segment.text).join(' '));
    const fragmentClean: any = evidenceText(fragment);
    if (!fuzzyTextMatches(transcriptText, fragmentClean))
        return false;
    const timeline: any = new Set(segments.map((segment: any): any => segment.timestamp).filter(Boolean));
    if (!timeline.size)
        return true;
    const timestamp: any = clean(evidence?.timestamp, 40);
    if (!timestamp)
        return segments.some((seg: any): any => fuzzyTextMatches(evidenceText(seg.text), fragmentClean));
    return timestampNearTimeline(timestamp, timeline);
}

function breakdownEvidence(item: any): any {
    if (item?.evidence?.fragment)
        return item.evidence;
    const fragment: any = item?.fragment || item?.original || item?.text;
    return fragment ? { timestamp: item?.timestamp ?? null, fragment } : null;
}

function evidenceText(value: any): any {
    return normalize(value).replace(/\[\s*时间点缺失\s*\]/gu, '').replace(/[\p{P}\p{S}\s]+/gu, '');
}

function clean(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalize(value: any): any { return clean(value, 100000).toLowerCase(); }


