import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertTypeScriptRatio, measureTypeScriptRatio } from '../scripts/check-typescript-ratio.mjs';

test('当前生产源码 TypeScript 比例不低于版本化 20% 门禁', async () => {
  const result = await assertTypeScriptRatio();
  assert.equal(result.counts.typescript, 45);
  assert.equal(result.counts.total, 206);
  assert.ok(result.ratio >= 0.2);
});

test('TypeScript 数量或比例回退时门禁失败', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typescript-ratio-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'export {};\n');
  await fs.writeFile(path.join(root, 'src', 'one.js'), 'export {};\n');
  const baselinePath = path.join(root, 'baseline.json');
  await fs.writeFile(baselinePath, JSON.stringify({ schemaVersion:'agent.army/typescript-ratio-baseline/v1', productionRoot:'src', extensions:['.ts', '.js'], minimumTypescriptFiles:2, minimumRatio:0.6 }));
  const measured = await measureTypeScriptRatio({ root, baselinePath });
  assert.equal(measured.ratio, 0.5);
  await assert.rejects(() => assertTypeScriptRatio({ root, baselinePath }), /从基线 2 降到 1/);
});
