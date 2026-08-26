import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SliceTranscriptCheckpointManager } from '../src/slice-transcript-checkpoint.ts';

test('SliceTranscriptCheckpointManager 准确保存切片、计算待完成切片并正确缝合时间轴', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaod-slice-test-'));
  try {
    const manager = new SliceTranscriptCheckpointManager({ jobDir: tmpDir });

    // 1. 保存第 1 个分片 (0~60s)
    manager.saveSlice({
      index: 1,
      startOffsetMs: 0,
      durationMs: 60000,
      text: '这是第一分片的发言。',
      segments: [{ startMs: 1000, endMs: 5000, text: '这是第一分片的发言。' }],
    });

    // 2. 保存第 3 个分片 (120~180s)，故意跳过第 2 个分片模拟中途失败
    manager.saveSlice({
      index: 3,
      startOffsetMs: 120000,
      durationMs: 60000,
      text: '这是第三分片的结论。',
      segments: [{ startMs: 2000, endMs: 8000, text: '这是第三分片的结论。' }],
    });

    assert.deepEqual(manager.listCompletedSliceIndices(), [1, 3]);
    assert.deepEqual(manager.getPendingSliceIndices(3), [2]);

    // 切片未齐时尝试缝合应抛错
    assert.throws(() => manager.stitchAllSlices(3), /切片未全部就绪/);

    // 3. 补齐第 2 个分片 (60~120s)
    manager.saveSlice({
      index: 2,
      startOffsetMs: 60000,
      durationMs: 60000,
      text: '这是第二分片的细节展开。',
      segments: [{ startMs: 500, endMs: 4000, text: '这是第二分片的细节展开。' }],
    });

    assert.deepEqual(manager.getPendingSliceIndices(3), []);

    // 4. 缝合
    const stitched = manager.stitchAllSlices(3);
    assert.equal(stitched.totalDurationMs, 180000);
    assert.ok(stitched.fullText.includes('第一分片'));
    assert.ok(stitched.fullText.includes('第二分片'));
    assert.ok(stitched.fullText.includes('第三分片'));

    // 验证切片 2 和切片 3 的时间轴偏移是否正确平移
    assert.equal(stitched.segments[0].startMs, 1000); // 1000 + 0
    assert.equal(stitched.segments[1].startMs, 60500); // 500 + 60000
    assert.equal(stitched.segments[2].startMs, 122000); // 2000 + 120000
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
