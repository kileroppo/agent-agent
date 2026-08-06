import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyGovernanceFeishuAcceptance } from '../scripts/verify-governance-feishu-acceptance.mjs';

test('六名员工各自真实回复且一人跨重启追问时验收通过', () => {
  const agentIds = ['creator', 'reviewer'];
  const result = verifyGovernanceFeishuAcceptance({
    agentIds,
    continuityAgentId:'creator',
    marker:'青松',
    profileHomeFor:(agentId) => `/profiles/${agentId}`,
    readManifest:(agentId) => ({ name:agentId }),
    inspectLaunchAgent:(agentId) => ({
      running:true,
      pid:agentId === 'creator' ? 101 : 102,
      startedAtMs:2000
    }),
    inspectProfile:(profileHome) => ({
      sessionCount:1,
      userMessages:profileHome.endsWith('/creator') ? 2 : 1,
      assistantMessages:profileHome.endsWith('/creator') ? 2 : 1,
      markerSeenInUser:true,
      markerSeenInAssistant:true,
      firstMessageAtMs:1000,
      lastMessageAtMs:3000,
      sessionFingerprint:profileHome
    })
  });
  assert.equal(result.passed, true);
  assert.equal(result.isolatedSessions, true);
  assert.equal(result.restartContinuityPassed, true);
});

test('共享会话指纹或没有跨重启消息时验收失败', () => {
  const result = verifyGovernanceFeishuAcceptance({
    agentIds:['creator', 'reviewer'],
    continuityAgentId:'creator',
    profileHomeFor:(agentId) => `/profiles/${agentId}`,
    readManifest:(agentId) => ({ name:agentId }),
    inspectLaunchAgent:() => ({ running:true, pid:101, startedAtMs:4000 }),
    inspectProfile:() => ({
      sessionCount:1,
      userMessages:2,
      assistantMessages:2,
      markerSeenInUser:true,
      markerSeenInAssistant:true,
      firstMessageAtMs:1000,
      lastMessageAtMs:3000,
      sessionFingerprint:'shared'
    })
  });
  assert.equal(result.passed, false);
  assert.equal(result.isolatedSessions, false);
  assert.equal(result.restartContinuityPassed, false);
});
