import { coded } from './policy.ts';
import { FilePublisherRepository } from './repository.ts';
import { WorkspaceArtifactVerifier } from './artifact-verifier.ts';
import { WechatDraftGateway } from './wechat-draft-gateway.ts';
import { WechatWenyanConnector } from './wechat-wenyan-connector.ts';
export const WECHAT_DRAFT_APPROVAL_SNAPSHOT_SCHEMA = 'agent.army/wechat-draft-connector-approval/v1';
const WECHAT_DRAFT_COMPOSITION = Symbol('wechat-draft-composition');
export function createWechatDraftComposition(options: any = {}) {
    if (options.enabled !== true)
        return null;
    const { approvalSnapshot, connectorDependencies, workspaceRoot, ledgerPath, paperclipControl, costReporter, clock = () => new Date(), } = options;
    const approval = validateWechatApproval(approvalSnapshot, clock());
    const runner = connectorDependencies?.wenyan?.runner;
    const credentialResolver = connectorDependencies?.wenyan?.credentialResolver;
    if (!runner || typeof credentialResolver !== 'function') {
        throw coded('wechat_draft_connector_dependency_missing', '公众号草稿 connector 缺少显式 Wenyan runner 或 Secret Reference resolver。');
    }
    return Object.freeze({
        [WECHAT_DRAFT_COMPOSITION]: true,
        mode: 'real',
        approvalSnapshotId: approval.snapshotId,
        accountRef: approval.accountRef,
        createGateway() {
            const connector = new WechatWenyanConnector({ runner, credentialResolver, clock });
            return new WechatDraftGateway({
                repository: new FilePublisherRepository(ledgerPath, { clock }),
                artifactVerifier: new WorkspaceArtifactVerifier(workspaceRoot),
                connector,
                approvalScope: {
                    accountRef: approval.accountRef,
                    secretRef: approval.secretRef,
                },
                paperclipControl,
                costReporter,
                clock,
            });
        },
    });
}
export function isWechatDraftComposition(value: any) {
    return value?.[WECHAT_DRAFT_COMPOSITION] === true
        && value?.mode === 'real'
        && typeof value?.createGateway === 'function';
}
function validateWechatApproval(value: any, now: any) {
    const expiresAt = Date.parse(value?.expiresAt);
    if (!(now instanceof Date)
        || Number.isNaN(now.getTime())
        || value?.schemaVersion !== WECHAT_DRAFT_APPROVAL_SNAPSHOT_SCHEMA
        || value?.source !== 'paperclip'
        || !String(value?.snapshotId || '').startsWith('paperclip:')
        || value?.status !== 'approved'
        || value?.platform !== 'wechat_official_account'
        || value?.capability !== 'create_wechat_draft'
        || value?.connectorKind !== 'wechat_wenyan_cli'
        || !String(value?.approvalRef || '').startsWith('paperclip:')
        || !String(value?.accountRef || '').startsWith('paperclip:account:')
        || !String(value?.secretRef || '').startsWith('paperclip:secret:')
        || !Number.isFinite(Date.parse(value?.capturedAt))
        || Date.parse(value.capturedAt) > now.getTime()
        || !Number.isFinite(expiresAt)
        || expiresAt <= now.getTime()) {
        throw coded('wechat_draft_approval_invalid', '公众号草稿连接器必须使用当前有效的 Paperclip 批准快照。');
    }
    return Object.freeze({
        snapshotId: value.snapshotId,
        accountRef: value.accountRef,
        secretRef: value.secretRef,
    });
}
