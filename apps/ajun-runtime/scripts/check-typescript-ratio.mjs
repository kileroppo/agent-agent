import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function measureTypeScriptRatio({ root = appRoot, baselinePath = path.join(root, 'typescript-ratio-baseline.json') } = {}) {
  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
  if (baseline.schemaVersion !== 'agent.army/typescript-ratio-baseline/v1') throw new Error('TypeScript 比例基线版本无效。');
  const productionRoot = path.resolve(root, String(baseline.productionRoot || 'src'));
  const counts = { typescript:0, javascript:0, moduleJavascript:0, total:0 };
  for (const file of await walk(productionRoot)) {
    const extension = path.extname(file);
    if (!baseline.extensions.includes(extension)) continue;
    if (extension === '.ts') counts.typescript += 1;
    if (extension === '.js') counts.javascript += 1;
    if (extension === '.mjs') counts.moduleJavascript += 1;
    counts.total += 1;
  }
  const ratio = counts.total ? counts.typescript / counts.total : 0;
  return { baseline, counts, ratio };
}

export async function assertTypeScriptRatio(options = {}) {
  const result = await measureTypeScriptRatio(options);
  const { baseline, counts, ratio } = result;
  if (counts.typescript < baseline.minimumTypescriptFiles) {
    throw new Error(`TypeScript 生产文件从基线 ${baseline.minimumTypescriptFiles} 降到 ${counts.typescript}。`);
  }
  if (ratio + Number.EPSILON < baseline.minimumRatio) {
    throw new Error(`TypeScript 比例 ${(ratio * 100).toFixed(2)}% 低于门禁 ${(baseline.minimumRatio * 100).toFixed(2)}%。`);
  }
  return result;
}

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes:true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await assertTypeScriptRatio();
  process.stdout.write(`typescript ratio: ${result.counts.typescript}/${result.counts.total} (${(result.ratio * 100).toFixed(2)}%)\n`);
}
