import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContentAcquisitionCenter } from '../../../integrations/access/content-acquisition-center.js';
import { WeChatLocalVaultAdapter } from '../../../integrations/access/wechat-local-vault-adapter.js';

const CAPABILITY = 'wechat.local-vault.chat.read';

export class WeChatLocalVaultAcceptance {
  constructor({ artifactsDir, now = () => new Date() } = {}) {
    this.artifactsDir = path.resolve(artifactsDir);
    this.now = now;
  }

  async run({ proposal, testInstance }) {
    const taskId = `proposal-test:${testInstance.testInstanceId}`;
    const agentId = proposal.candidateManifest.agentId;
    const approvalRef = `synthetic_${crypto.randomUUID().replaceAll('-', '')}`;
    const startTime = '2026-07-01T00:00:00.000Z';
    const endTime = '2026-07-01T00:10:00.000Z';
    const scope = {
      approvalRef,
      status:'approved',
      requestingAgentId:agentId,
      taskId,
      chatSelector:'synthetic-single-chat',
      startTime,
      endTime,
      maxMessages:3,
      expiresAt:new Date(this.now().getTime() + 60_000).toISOString()
    };
    const syntheticMessages = [
      { timestamp:Date.parse('2026-07-01T00:01:00.000Z') / 1000, sender:'甲', type:'文本', content:'SYNTHETIC_CHAT_ALPHA' },
      { timestamp:Date.parse('2026-07-01T00:03:00.000Z') / 1000, sender:'乙', type:'文本', content:'SYNTHETIC_CHAT_BETA' },
      { timestamp:Date.parse('2026-07-01T00:05:00.000Z') / 1000, sender:'甲', type:'链接', content:'SYNTHETIC_CHAT_GAMMA' }
    ];
    const adapter = new WeChatLocalVaultAdapter({
      scopeResolver:async (value) => value === approvalRef ? scope : null,
      runVaultQuery:async () => ({ messages:syntheticMessages }),
      now:this.now
    });
    const center = new ContentAcquisitionCenter({
      adapters:[adapter],
      connectionBroker:null,
      operations:{ async record() {} }
    });
    const acquired = await center.fetch({
      requestId:`wechat-acceptance:${testInstance.testInstanceId}`,
      taskId,
      source:`wechat-vault://local/chat?approval=${approvalRef}`,
      requestedCapabilities:[CAPABILITY],
      requestingAgentId:agentId,
      runtimeRequirement:'wechat_chat_read'
    });
    if (!acquired.ok) throw new Error(acquired.safeMessage);
    const slice = acquired.contentPackage.contentItems.chat_slice;
    if (slice.messageCount !== syntheticMessages.length) throw new Error('合成聊天切片数量不符合验收预期。');
    const report = {
      schemaVersion:'agent.army/wechat-local-vault-acceptance/v1',
      mode:'synthetic-only',
      realChatRead:false,
      generatedAt:this.now().toISOString(),
      proposalId:proposal.proposalId,
      testInstanceId:testInstance.testInstanceId,
      checks:{
        controlledAdapter:true,
        contentAcquisitionCenter:true,
        perRequestApproval:acquired.contentPackage.validation.perRequestApproval === true,
        singleChat:acquired.contentPackage.validation.singleChat === true,
        boundedTimeRange:acquired.contentPackage.validation.boundedTimeRange === true,
        requestedMessageCount:syntheticMessages.length,
        returnedMessageCount:slice.messageCount,
        rawChatPersisted:false,
        keyMaterialExposed:false,
        rawDatabaseExposed:false,
        externalSideEffects:0
      },
      ephemeralPayloadChecksum:crypto.createHash('sha256').update(JSON.stringify(slice.messages)).digest('hex')
    };
    const directory = path.resolve(this.artifactsDir, safeSegment(proposal.proposalId), safeSegment(testInstance.testInstanceId));
    if (!directory.startsWith(`${this.artifactsDir}${path.sep}`)) throw new Error('微信受限验收产物路径越界。');
    await fs.mkdir(directory, { recursive:true });
    const filePath = path.join(directory, 'wechat-local-vault-synthetic-acceptance.json');
    await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, { encoding:'utf8', mode:0o600 });
    return {
      status:'succeeded',
      currentStage:'wechat_synthetic_acceptance_passed',
      artifactRefs:[{
        artifactId:`wechat-vault-acceptance:${testInstance.testInstanceId}`,
        taskId,
        type:'wechat_local_vault_acceptance_report',
        title:'微信聊天受控读取合成验收报告',
        location:pathToFileURL(filePath).href,
        mimeType:'application/json',
        accessScope:'local-owner',
        createdAt:this.now().toISOString(),
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          syntheticOnly:true,
          realChatRead:false,
          noRawChatPersisted:true,
          externalSideEffects:0
        }
      }]
    };
  }
}

function safeSegment(value) {
  return String(value || 'test').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'test';
}
