import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  importStepFunSecret,
  parseEnvValue,
  readPrivateEnvValue,
} from './import-stepfun-secret.mjs';

const companyId = '11111111-1111-4111-8111-111111111111';
const secretId = '22222222-2222-4222-8222-222222222222';
const secretValue = 'stepfun-unit-secret-never-print';

test('从0600普通文件读取并只向local_encrypted API发送一次密钥', async (context) => {
  const fixture = await privateFixture(context, `IGNORED=yes\nSTEPFUN_API_KEY='${secretValue}'\n`);
  const calls = [];
  const result = await importStepFunSecret({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    envFile:fixture,
    fetchImpl:async (url, init) => {
      calls.push({ url:String(url), init });
      if (init.method === 'GET') return jsonResponse([]);
      const body = JSON.parse(init.body);
      assert.equal(body.value, secretValue);
      assert.equal(body.key, 'STEPFUN_M5_API_KEY');
      assert.equal(body.provider, 'local_encrypted');
      return jsonResponse({
        id:secretId,
        key:body.key.toLowerCase(),
        provider:body.provider,
        status:'active',
      }, 201);
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(result, {
    id:secretId,
    key:'stepfun_m5_api_key',
    provider:'local_encrypted',
    status:'active',
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretValue));
});

test('同key已存在时拒绝重复且不读取或POST密钥', async () => {
  let requestCount = 0;
  await assert.rejects(
    importStepFunSecret({
      apiBase:'http://127.0.0.1:3100',
      companyId,
      envFile:'/path/that/must/not/be/read',
      fetchImpl:async (_url, init) => {
        requestCount += 1;
        assert.equal(init.method, 'GET');
        return jsonResponse([{ key:'stepfun_m5_api_key', status:'active' }]);
      },
    }),
    /拒绝重复导入/,
  );
  assert.equal(requestCount, 1);
});

test('拒绝权限过宽文件、符号链接和重复env键', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-import-security-'));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));

  const broad = path.join(directory, 'broad.env');
  await fs.writeFile(broad, `STEPFUN_API_KEY=${secretValue}\n`, { mode:0o644 });
  await assert.rejects(readPrivateEnvValue(broad), /0600 普通文件/);

  const target = path.join(directory, 'target.env');
  const link = path.join(directory, 'link.env');
  await fs.writeFile(target, `STEPFUN_API_KEY=${secretValue}\n`, { mode:0o600 });
  await fs.symlink(target, link);
  await assert.rejects(readPrivateEnvValue(link), /无法安全打开/);

  assert.throws(
    () => parseEnvValue(`STEPFUN_API_KEY=one\nSTEPFUN_API_KEY=two\n`),
    /存在重复/,
  );
});

test('服务端错误正文即使包含密钥也不会进入错误消息', async (context) => {
  const fixture = await privateFixture(context, `STEPFUN_API_KEY=${secretValue}\n`);
  let count = 0;
  await assert.rejects(
    importStepFunSecret({
      apiBase:'http://127.0.0.1:3100',
      companyId,
      envFile:fixture,
      fetchImpl:async () => {
        count += 1;
        return count === 1
          ? jsonResponse([])
          : new Response(`provider rejected ${secretValue}`, { status:500 });
      },
    }),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.doesNotMatch(error.message, new RegExp(secretValue));
      return true;
    },
  );
});

test('导入器不使用环境变量、子进程、curl或临时文件传递密钥', async () => {
  const script = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'import-stepfun-secret.mjs'),
    'utf8',
  );
  assert.doesNotMatch(script, /process\.env/);
  assert.doesNotMatch(script, /node:child_process|\bspawn\(|\bexecFile\(|\bcurl\b/);
  assert.doesNotMatch(script, /mkdtemp|writeFile|appendFile|createWriteStream/);
});

async function privateFixture(context, content) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-import-'));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, 'stepfun.env');
  await fs.writeFile(file, content, { mode:0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers:{ 'content-type':'application/json' },
  });
}
