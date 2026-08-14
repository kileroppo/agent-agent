import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createVisualEvidencePackage, hammingDistance, selectFrameCandidates } from '../src/visual-evidence.ts';

test('关键帧候选优先覆盖开头、结尾、字幕锚点和场景变化', () => {
  const candidates = selectFrameCandidates({
    durationSeconds:120,
    transcriptSegments:[{ startSeconds:10 }, { startSeconds:55 }, { startSeconds:100 }],
    sceneTimes:[5, 20, 40, 80, 110],
    maxFrames:12
  });
  assert.ok(candidates.length <= 36);
  assert.ok(candidates.slice(0, 6).some((item) => item.timestampSeconds < 3));
  assert.ok(candidates.slice(0, 6).some((item) => item.timestampSeconds > 100));
  assert.ok(candidates.some((item) => item.reason === 'transcript_cue'));
  assert.ok(candidates.some((item) => item.reason === 'scene_change'));
});

test('感知哈希按位差识别相同和接近画面', () => {
  assert.equal(hammingDistance(0b1010n, 0b1010n), 0);
  assert.equal(hammingDistance(0b1010n, 0b1110n), 1);
});

test('真实 FFmpeg 生成带时间标签的关键帧、故事板和受控清单', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-evidence-test-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const videoPath = path.join(root, 'sample.mp4');
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=duration=6:size=640x360:rate=2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    videoPath
  ]);
  const created = await createVisualEvidencePackage({
    videoPath,
    outputDir:path.join(root, 'visual'),
    depth:'fast',
    transcriptSegments:[{ startSeconds:0.5 }, { startSeconds:3 }],
    sourceMetadata:{ title:'合成样片', platform:'local_upload' }
  });
  assert.equal(created.payload.schemaVersion, 'agent.army/visual-evidence/v1');
  assert.ok(created.payload.frames.length >= 6);
  assert.ok(created.payload.frames.length <= 12);
  assert.equal(created.payload.storyboards.length, 1);
  assert.deepEqual(
    created.payload.frames.map((frame) => frame.timestampSeconds),
    [...created.payload.frames].map((frame) => frame.timestampSeconds).sort((a, b) => a - b)
  );
  assert.ok(created.payload.frames.every((frame) => frame.checksum.startsWith('sha256:')));
  assert.ok(created.payload.storyboards.every((board) => board.frameRefs.length <= 12));
  await fs.access(created.manifestPath);
  await fs.access(created.storyboardPaths[0]);
});

function exec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer:4 * 1024 * 1024 }, (error) => error ? reject(error) : resolve());
  });
}
