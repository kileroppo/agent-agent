import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TechnicalRepairPromotion } from '../src/technical-repair-promotion.js';

const evidence = { metadata:{ agentArmyRepairEvidence:{ changedFiles:['src/fix.js'], testsPassed:true, recoveryVerified:true } } };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('检查通过且主工程未变化时，A君 才带回允许范围内的修复', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-promotion-')); const workspace = path.join(root, 'workspace');
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'src'), { recursive:true }); await fs.mkdir(path.join(workspace, 'src'), { recursive:true });
  await fs.writeFile(path.join(root, 'src/fix.js'), 'before\n'); await fs.writeFile(path.join(workspace, 'src/fix.js'), 'after\n');
  await fs.writeFile(path.join(workspace, '.agent-army-repair-snapshot.json'), JSON.stringify({ files:{ 'src/fix.js':{ sourceHash:hash('before\n') } } }));
  const result = await new TechnicalRepairPromotion({ projectRoot:root }).promote({ execution:{ workspace:{ path:workspace } }, input:{ context:{ repairScope:{ files:['src/fix.js'] } } } }, evidence);
  assert.equal(result.status, 'promoted'); assert.equal(await fs.readFile(path.join(root, 'src/fix.js'), 'utf8'), 'after\n');
});

test('主工程同一文件已经变化时，A君 不覆盖并留下冲突', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-promotion-')); const workspace = path.join(root, 'workspace');
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'src'), { recursive:true }); await fs.mkdir(path.join(workspace, 'src'), { recursive:true });
  await fs.writeFile(path.join(root, 'src/fix.js'), 'someone else\n'); await fs.writeFile(path.join(workspace, 'src/fix.js'), 'after\n');
  await fs.writeFile(path.join(workspace, '.agent-army-repair-snapshot.json'), JSON.stringify({ files:{ 'src/fix.js':{ sourceHash:hash('before\n') } } }));
  const result = await new TechnicalRepairPromotion({ projectRoot:root }).promote({ execution:{ workspace:{ path:workspace } }, input:{ context:{ repairScope:{ files:['src/fix.js'] } } } }, evidence);
  assert.equal(result.status, 'conflict'); assert.equal(await fs.readFile(path.join(root, 'src/fix.js'), 'utf8'), 'someone else\n');
});
