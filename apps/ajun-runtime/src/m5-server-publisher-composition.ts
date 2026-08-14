import { AsyncLocalStorage } from 'node:async_hooks';
import { createM5PublisherBindings } from './m5-publisher-bindings.ts';
import { PaperclipMetricRecoveryAccess } from './paperclip-metric-recovery-access.ts';
const CORE_PAPERCLIP_ACCESS_METHODS: any = Object.freeze([
    'authorizePublisherRequest',
    'getPublisherConnectorApprovalSnapshot',
    'resolvePublisherCredentialReference',
    'verifyPublisherAccountIdentity',
    'assertPublisherCampaignBudget',
    'recordPublisherConnectorAttempt',
]);
export class PaperclipCurrentRunScope {
    storage: any;
    constructor() {
        this.storage = new AsyncLocalStorage();
    }
    run(credential: any, operation: any): any {
        if (typeof operation !== 'function') {
            throw new TypeError('current Run operation 必须是函数。');
        }
        return this.storage.run(Object.freeze(structuredClone(credential)), operation);
    }
    async currentCredential(): Promise<any> {
        const credential: any = this.storage.getStore();
        if (!credential) {
            throw new Error('当前请求不属于已认证的 Paperclip Run。');
        }
        return structuredClone(credential);
    }
}
// 保留旧导出，避免指标恢复调用方一次性迁移；实现已统一为通用 current Run scope。
export class PaperclipMetricRecoveryRunScope extends PaperclipCurrentRunScope {
}
export function createM5ServerPublisherComposition({ env = process.env, dataDir, clock, getCampaignService, production = null, currentRunCredentialProvider, paperclipBaseUrl = 'http://127.0.0.1:3100', recoveryFetchImpl, }: any = {}): any {
    let composedProduction: any = production;
    if (production?.enabled === true) {
        const recoveryAccess: any = new PaperclipMetricRecoveryAccess({
            baseUrl: paperclipBaseUrl,
            ...(recoveryFetchImpl ? { fetchImpl: recoveryFetchImpl } : {}),
            currentRunCredentialProvider,
            clock,
        });
        composedProduction = {
            ...production,
            paperclipAccess: composePaperclipAccess(production.paperclipAccess, recoveryAccess),
        };
    }
    return createM5PublisherBindings({
        env,
        dataDir,
        clock,
        getCampaignService,
        production: composedProduction,
    });
}
function composePaperclipAccess(coreAccess: any, recoveryAccess: any): any {
    if (CORE_PAPERCLIP_ACCESS_METHODS.some((method: any): any => typeof coreAccess?.[method] !== 'function')) {
        throw new TypeError('生产 Publisher 缺少 Paperclip 核心 access provider。');
    }
    return Object.freeze({
        ...Object.fromEntries(CORE_PAPERCLIP_ACCESS_METHODS.map((method: any): any => [
            method,
            (...args: any): any => coreAccess[method](...args),
        ])),
        assertPublisherMetricRecoveryAllowed: (input: any): any => (recoveryAccess.assertPublisherMetricRecoveryAllowed(input)),
    });
}
