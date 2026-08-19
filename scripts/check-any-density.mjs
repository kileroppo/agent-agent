import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(
  process.env.AGENT_ARMY_ARCHITECTURE_ROOT
    || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
);

const baselinePath = path.join(root, 'any-density-baseline.json');
const anyPattern = /:\s*any\b/;

async function loadBaseline() {
  const raw = await fs.readFile(baselinePath, 'utf8');
  const baseline = JSON.parse(raw);
  if (baseline.schemaVersion !== 'agent.army/any-density-baseline/v1') {
    throw new Error('any-density-baseline.json: unsupported schemaVersion');
  }
  return baseline;
}

async function walkTsFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkTsFiles(target));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(target);
    }
  }
  return files;
}

async function countAnyInDirectory(directoryRelative) {
  const directory = path.join(root, directoryRelative);
  const files = await walkTsFiles(directory);
  let anyCount = 0;
  let totalLines = 0;
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const lines = source.split(/\r?\n/);
    totalLines += lines.length;
    for (const line of lines) {
      if (anyPattern.test(line)) anyCount += 1;
    }
  }
  return { anyCount, totalLines, fileCount: files.length };
}

export { loadBaseline, walkTsFiles, countAnyInDirectory, anyPattern };

async function main() {
  const baseline = await loadBaseline();
  const directories = Object.keys(baseline.directories);
  const results = [];
  let failed = false;

  for (const dir of directories) {
    const { anyCount, totalLines } = await countAnyInDirectory(dir);
    const maxCount = baseline.directories[dir].maxCount;
    const exceeded = anyCount > maxCount;
    if (exceeded) failed = true;
    results.push({ dir, anyCount, totalLines, maxCount, exceeded });
  }

  const dirColWidth = Math.max(9, ...results.map((r) => r.dir.length));
  const header = `${'Directory'.padEnd(dirColWidth)}  Current  Baseline  Status`;
  const separator = '-'.repeat(header.length);
  console.log('');
  console.log('any-density gate');
  console.log(separator);
  console.log(header);
  console.log(separator);
  for (const r of results) {
    const status = r.exceeded ? 'FAIL' : 'ok';
    const line = `${r.dir.padEnd(dirColWidth)}  ${String(r.anyCount).padStart(7)}  ${String(r.maxCount).padStart(8)}  ${status}`;
    console.log(line);
  }
  console.log(separator);
  console.log('');

  if (failed) {
    console.error('any-density gate: FAILED - one or more directories exceed their baseline');
    process.exitCode = 1;
  } else {
    console.log('any-density gate: ok');
  }
}

main();
