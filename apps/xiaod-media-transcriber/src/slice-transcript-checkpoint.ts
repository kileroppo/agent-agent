import fs from 'node:fs';
import path from 'node:path';

export type TranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export type SliceTranscriptData = {
  index: number;
  startOffsetMs: number;
  durationMs: number;
  text: string;
  segments: TranscriptSegment[];
};

export class SliceTranscriptCheckpointManager {
  private readonly slicesDir: string;

  constructor({ jobDir }: { jobDir: string }) {
    this.slicesDir = path.join(jobDir, 'slices');
    if (!fs.existsSync(this.slicesDir)) {
      fs.mkdirSync(this.slicesDir, { recursive: true, mode: 0o700 });
    }
  }

  private sliceFilePath(index: number): string {
    const filename = `slice-${String(index).padStart(4, '0')}.json`;
    return path.join(this.slicesDir, filename);
  }

  saveSlice(slice: SliceTranscriptData): void {
    if (!slice || slice.index <= 0) {
      throw new Error('无效的切片索引。');
    }
    const targetFile = this.sliceFilePath(slice.index);
    fs.writeFileSync(targetFile, JSON.stringify(slice, null, 2), 'utf8');
  }

  getSlice(index: number): SliceTranscriptData | null {
    const targetFile = this.sliceFilePath(index);
    if (!fs.existsSync(targetFile)) return null;
    try {
      const raw = fs.readFileSync(targetFile, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  listCompletedSliceIndices(): number[] {
    if (!fs.existsSync(this.slicesDir)) return [];
    const files = fs.readdirSync(this.slicesDir);
    const indices: number[] = [];

    for (const file of files) {
      const match = file.match(/^slice-(\d{4})\.json$/);
      if (match && match[1]) {
        const idx = Number.parseInt(match[1], 10);
        if (idx > 0) indices.push(idx);
      }
    }

    return indices.sort((a, b) => a - b);
  }

  getPendingSliceIndices(totalSlices: number): number[] {
    const completed = new Set(this.listCompletedSliceIndices());
    const pending: number[] = [];

    for (let i = 1; i <= totalSlices; i++) {
      if (!completed.has(i)) {
        pending.push(i);
      }
    }

    return pending;
  }

  stitchAllSlices(totalSlices: number): {
    fullText: string;
    segments: TranscriptSegment[];
    totalDurationMs: number;
  } {
    const pending = this.getPendingSliceIndices(totalSlices);
    if (pending.length > 0) {
      throw new Error(`切片未全部就绪，尚缺以下切片: [${pending.join(', ')}]`);
    }

    const allSegments: TranscriptSegment[] = [];
    const textPieces: string[] = [];
    let totalDurationMs = 0;

    for (let i = 1; i <= totalSlices; i++) {
      const slice = this.getSlice(i);
      if (!slice) {
        throw new Error(`读取切片 ${i} 失败。`);
      }

      const offset = slice.startOffsetMs || 0;
      for (const seg of slice.segments || []) {
        allSegments.push({
          startMs: seg.startMs + offset,
          endMs: seg.endMs + offset,
          text: seg.text,
        });
      }

      if (slice.text) {
        textPieces.push(slice.text.trim());
      }

      totalDurationMs += slice.durationMs || 0;
    }

    return {
      fullText: textPieces.join('\n\n'),
      segments: allSegments,
      totalDurationMs,
    };
  }
}
