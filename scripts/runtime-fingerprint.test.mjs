import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectRuntimeFingerprint,
  findReleaseIdentity,
  parseGitStatusPorcelain,
  summarizeServiceHealth,
} from './runtime-fingerprint.mjs';

test('Git 状态只输出计数，不泄露文件名', () => {
  assert.deepEqual(parseGitStatusPorcelain([
    ' M README.md',
    'M  package.json',
    'MM apps/runtime.js',
    '?? secret-looking-name.txt',
  ].join('\n')), {
    clean:false,
    changedPathCount:4,
    stagedPathCount:2,
    unstagedPathCount:2,
    untrackedPathCount:1,
  });
});

test('不可变 release 只输出固定身份字段', () => {
  const releaseHash = 'a'.repeat(64);
  const payloadHash = 'b'.repeat(64);
  const gitHead = 'c'.repeat(40);
  const start = `/repo/work/runtime-${releaseHash}/apps/ajun-runtime`;
  const manifestPath = `/repo/work/runtime-${releaseHash}/release-manifest.json`;
  const identity = findReleaseIdentity(start, {
    exists:(file) => file === manifestPath,
    read:() => JSON.stringify({
      kind:'agent-army/ajun-immutable-runtime-release',
      payloadHash,
      git:{ gitHead, worktreeState:'clean' },
      runtimeAbi:{ node:'v22.1.0', platform:'darwin', arch:'arm64' },
      ignoredSecret:'must-not-appear',
    }),
  });
  assert.deepEqual(identity, {
    status:'immutable_release',
    releaseHash,
    payloadHash,
    gitHead,
    worktreeState:'clean',
    runtimeAbi:{ node:'v22.1.0', platform:'darwin', arch:'arm64' },
  });
  assert.doesNotMatch(JSON.stringify(identity), /ignoredSecret|must-not-appear/);
});

test('服务摘要严格裁剪健康正文', () => {
  const summary = summarizeServiceHealth('publisher', {
    httpStatus:200,
    body:{
      status:'disabled',
      mode:'disabled',
      hardStop:false,
      realConnectorsConfigured:false,
      token:'must-not-appear',
    },
  });
  assert.deepEqual(summary, {
    reachable:true,
    httpStatus:200,
    status:'disabled',
    mode:'disabled',
    hardStop:false,
    realConnectorsConfigured:false,
  });
  assert.doesNotMatch(JSON.stringify(summary), /token|must-not-appear/);
});

test('完整指纹区分当前源码与 live release Git 身份', async () => {
  const sourceHead = '1'.repeat(40);
  const liveHead = '2'.repeat(40);
  const command = (file, args) => {
    if (file === 'git' && args[0] === 'rev-parse') return `${sourceHead}\n`;
    if (file === 'git' && args[0] === 'branch') return 'codex/example\n';
    if (file === 'git' && args[0] === 'status') return ' M README.md\n';
    if (file === 'lsof' && args.includes('-iTCP:4321')) return '42\n';
    if (file === 'lsof' && args.includes('-d')) return 'p42\nfcwd\nn/release/apps/ajun-runtime\n';
    return '';
  };
  const request = async (url) => {
    if (url.includes(':4321')) return { httpStatus:200, body:{ agents:[], alwaysOnAgents:[], onDemandAgents:[], taskFocus:{ total:0, inProgress:0, backgroundInProgress:0, waitingApproval:0 }, capabilities:[] } };
    if (url.includes(':3100')) return { httpStatus:200, body:{ status:'ok', version:'1.0.0' } };
    if (url.includes(':4318')) return { httpStatus:200, body:{ ok:true, capabilities:{ asr:true } } };
    return { httpStatus:200, body:{ status:'disabled', mode:'disabled', hardStop:false, realConnectorsConfigured:false } };
  };
  const result = await collectRuntimeFingerprint({
    root:'/repo',
    command,
    request,
    releaseIdentity:() => ({ status:'immutable_release', gitHead:liveHead }),
    now:() => new Date('2026-08-06T00:00:00.000Z'),
  });
  assert.equal(result.status, 'observed');
  assert.equal(result.live.sourceRelationship, 'different_git_head');
  assert.equal(result.source.gitHead, sourceHead);
  assert.equal(result.source.clean, false);
  assert.equal(result.generatedAt, '2026-08-06T00:00:00.000Z');
  assert.deepEqual(result.safety, { readOnly:true, secretsRead:false, externalEffects:false });
});

test('源码身份缺失或任一关键服务不可达时不伪报已观察到同一运行版本', async () => {
  const liveHead = '2'.repeat(40);
  const command = (file, args) => {
    if (file === 'git' && args[0] === 'rev-parse') return 'not-a-git-head\n';
    if (file === 'git' && args[0] === 'branch') return 'codex/example\n';
    if (file === 'git' && args[0] === 'status') return '';
    if (file === 'lsof' && args.includes('-iTCP:4321')) return '42\n';
    if (file === 'lsof' && args.includes('-d')) return 'p42\nfcwd\nn/release/apps/ajun-runtime\n';
    return '';
  };
  const request = async (url) => {
    if (url.includes(':4321')) return { httpStatus:200, body:{ agents:[], alwaysOnAgents:[], onDemandAgents:[], taskFocus:{} } };
    if (url.includes(':3100')) return { httpStatus:200, body:{ status:'ok' } };
    if (url.includes(':4318')) return { httpStatus:200, body:{ ok:true } };
    return { httpStatus:null, body:{} };
  };
  const result = await collectRuntimeFingerprint({
    root:'/repo',
    command,
    request,
    releaseIdentity:() => ({ status:'immutable_release', gitHead:liveHead }),
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.live.sourceRelationship, 'unproven');
  assert.equal(result.live.services.publisher.reachable, false);
});
