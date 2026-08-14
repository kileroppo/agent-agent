import assert from 'node:assert/strict';
import test from 'node:test';
import { createHermesModelProfileResolver } from '../src/hermes-model-profile-resolver.ts';

function resolverFixture({ agentStatus = 'draft', proposalStatus = 'testing', acceptanceStatus = 'passed', instanceStatus = 'passed', runtimeProfileRef = 'integrations/hermes/profiles/video-content-analyst.profile.json' } = {}) {
  return createHermesModelProfileResolver({
    root:'/workspace',
    registry:{ async get() { return { status:agentStatus, runtimeProfileRef }; } },
    proposalStore:{
      async listProposals() {
        return [{
          proposalId:'proposal-1',
          status:proposalStatus,
          acceptance:{ status:acceptanceStatus },
          candidateManifest:{ agentId:'video-content-analyst', runtimeProfileRef }
        }];
      },
      async listTestInstances() {
        return [{ proposalId:'proposal-1', status:instanceStatus }];
      }
    },
    readFile:async () => JSON.stringify({ profileId:'video-content-analyst' })
  });
}

test('已通过受限测试的 testing 岗位可以打开自己的隔离模型授权页', async () => {
  const resolve = resolverFixture();
  assert.equal(await resolve('video-content-analyst'), 'video-content-analyst');
});

test('testing 岗位缺少验收、通过实例或受控 Profile 映射时拒绝授权', async () => {
  assert.equal(await resolverFixture({ acceptanceStatus:'pending' })('video-content-analyst'), null);
  assert.equal(await resolverFixture({ instanceStatus:'ready' })('video-content-analyst'), null);
  assert.equal(await resolverFixture({ runtimeProfileRef:'../../outside.json' })('video-content-analyst'), null);
});

test('正式 active 岗位继续使用原有 Profile 授权路径', async () => {
  const resolve = resolverFixture({ agentStatus:'active', proposalStatus:'draft', acceptanceStatus:'pending', instanceStatus:'ready' });
  assert.equal(await resolve('video-content-analyst'), 'video-content-analyst');
});
