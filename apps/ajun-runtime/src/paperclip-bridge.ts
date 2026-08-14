import { PaperclipHttpTransport } from '@agent-army/paperclip-client';
import { PaperclipTaskProjector } from './paperclip-task-projector.ts';
import { paperclipOrganizationMethods } from './paperclip-organization.ts';
import { paperclipIssueMethods } from './paperclip-issue-operations.ts';
import { paperclipM5CaseMethods } from './paperclip-m5-case-operations.ts';
import { paperclipPublisherMethods } from './paperclip-publisher.ts';
const DEFAULT_URL: any = 'http://127.0.0.1:3100';
export class PaperclipBridge {
    baseUrl: any;
    clock: any;
    fetch: any;
    publisherRunCredentialProvider: any;
    taskProjector: any;
    transport: any;
    declare companyForRuntime: () => Promise<any>;
    constructor({ baseUrl = process.env.PAPERCLIP_URL || DEFAULT_URL, fetchImpl = fetch, publisherRunCredentialProvider = null, clock = (): any => new Date(), }: any = {}) {
        this.transport = new PaperclipHttpTransport({ baseUrl, allowRemote: false, fetchImpl, timeoutMs: 2500 });
        this.taskProjector = new PaperclipTaskProjector({ endpoint: this.transport, clock });
        this.baseUrl = this.transport.baseUrl;
        this.fetch = fetchImpl;
        this.publisherRunCredentialProvider = publisherRunCredentialProvider;
        this.clock = clock;
    }
    async project(task: any, approval: any): Promise<any> {
        return this.taskProjector.project(task, approval);
    }
    async projectChild(task: any, parentIssueId: any): Promise<any> {
        return this.taskProjector.projectChild(task, parentIssueId);
    }
    async health(): Promise<any> {
        try {
            const status: any = await this.request('/api/health');
            return { status: status.status === 'ok' ? 'ready' : 'degraded', version: status.version || null };
        }
        catch {
            return { status: 'offline', version: null };
        }
    }
    async request(path: any, options: any = {}): Promise<any> {
        return this.transport.request(options.method || 'GET', path, options);
    }
}
Object.assign(PaperclipBridge.prototype, paperclipOrganizationMethods, paperclipIssueMethods, paperclipM5CaseMethods, paperclipPublisherMethods);
