import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'check-any-density.mjs');

async function createTempProject(files, baseline) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'any-density-test-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(tempDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  await fs.writeFile(
    path.join(tempDir, 'any-density-baseline.json'),
    JSON.stringify(baseline),
  );
  return tempDir;
}

async function cleanup(tempDir) {
  await fs.rm(tempDir, { recursive: true, force: true });
}

describe('check-any-density', () => {
  it('counts lines containing : any and passes when within baseline', async () => {
    const tempDir = await createTempProject(
      {
        'src/a.ts': [
          'const x: any = 1;',
          'const y: string = "hello";',
          'function f(a: any, b:any): any {',
          '  return a;',
          '}',
        ].join('\n'),
        'src/b.ts': [
          'type Foo = { bar: any };',
          'const z: number = 42;',
        ].join('\n'),
      },
      {
        schemaVersion: 'agent.army/any-density-baseline/v1',
        directories: {
          src: { maxCount: 3, recordedLines: 7 },
        },
      },
    );
    try {
      const { stdout } = await execFileAsync('node', [scriptPath], {
        env: { ...process.env, AGENT_ARMY_ARCHITECTURE_ROOT: tempDir },
      });
      assert.match(stdout, /any-density gate: ok/);
      assert.match(stdout, /3/);
    } finally {
      await cleanup(tempDir);
    }
  });

  it('fails when count exceeds baseline', async () => {
    const tempDir = await createTempProject(
      {
        'src/c.ts': [
          'const a: any = 1;',
          'const b: any = 2;',
          'const c: any = 3;',
        ].join('\n'),
      },
      {
        schemaVersion: 'agent.army/any-density-baseline/v1',
        directories: {
          src: { maxCount: 2, recordedLines: 3 },
        },
      },
    );
    try {
      await assert.rejects(
        execFileAsync('node', [scriptPath], {
          env: { ...process.env, AGENT_ARMY_ARCHITECTURE_ROOT: tempDir },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /FAILED/);
          return true;
        },
      );
    } finally {
      await cleanup(tempDir);
    }
  });

  it('passes when count equals baseline exactly', async () => {
    const tempDir = await createTempProject(
      {
        'src/d.ts': [
          'const x: any = 1;',
          'const y: any = 2;',
        ].join('\n'),
      },
      {
        schemaVersion: 'agent.army/any-density-baseline/v1',
        directories: {
          src: { maxCount: 2, recordedLines: 2 },
        },
      },
    );
    try {
      const { stdout } = await execFileAsync('node', [scriptPath], {
        env: { ...process.env, AGENT_ARMY_ARCHITECTURE_ROOT: tempDir },
      });
      assert.match(stdout, /any-density gate: ok/);
    } finally {
      await cleanup(tempDir);
    }
  });

  it('handles : any with varying whitespace and respects word boundary', async () => {
    const tempDir = await createTempProject(
      {
        'src/e.ts': [
          'const a:any = 1;',
          'const b:  any = 2;',
          'const c:\tany = 3;',
          'const d: anything = 4;',
        ].join('\n'),
      },
      {
        schemaVersion: 'agent.army/any-density-baseline/v1',
        directories: {
          src: { maxCount: 3, recordedLines: 4 },
        },
      },
    );
    try {
      const { stdout } = await execFileAsync('node', [scriptPath], {
        env: { ...process.env, AGENT_ARMY_ARCHITECTURE_ROOT: tempDir },
      });
      assert.match(stdout, /any-density gate: ok/);
    } finally {
      await cleanup(tempDir);
    }
  });

  it('counts per line not per occurrence (multiple : any on one line counts as 1)', async () => {
    const tempDir = await createTempProject(
      {
        'src/f.ts': [
          'function f(a: any, b: any): any { return a; }',
        ].join('\n'),
      },
      {
        schemaVersion: 'agent.army/any-density-baseline/v1',
        directories: {
          src: { maxCount: 1, recordedLines: 1 },
        },
      },
    );
    try {
      const { stdout } = await execFileAsync('node', [scriptPath], {
        env: { ...process.env, AGENT_ARMY_ARCHITECTURE_ROOT: tempDir },
      });
      assert.match(stdout, /any-density gate: ok/);
    } finally {
      await cleanup(tempDir);
    }
  });
});
