import { PaperclipHttpTransport } from '@agent-army/paperclip-client';
import { PaperclipTaskProjector } from './paperclip-task-projector.js';
import { paperclipOrganizationMethods } from './paperclip-organization.js';
import { paperclipIssueMethods } from './paperclip-issue-operations.js';
import { paperclipM5CaseMethods } from './paperclip-m5-case-operations.js';
import { paperclipPublisherMethods } from './paperclip-publisher.js';

const DEFAULT_URL = 'http://127.0.0.1:3100';

export class PaperclipBridge {
  constructor({
    baseUrl = process.env.PAPERCLIP_URL || DEFAULT_URL,
    fetchImpl = fetch,
    publisherRunCredentialProvider = null,
    clock = () => new Date(),
  } = {}) {
    this.transport = new PaperclipHttpTransport({ baseUrl, allowRemote:false, fetchImpl, timeoutMs:2500 });
    this.taskProjector = new PaperclipTaskProjector({ endpoint:this.transport, clock });
    this.baseUrl = this.transport.baseUrl;
    this.fetch = fetchImpl;
    this.publisherRunCredentialProvider = publisherRunCredentialProvider;
    this.clock = clock;
  }

  async project(task, approval) {
    return this.taskProjector.project(task, approval);
  }

  async projectChild(task, parentIssueId) {
    return this.taskProjector.projectChild(task, parentIssueId);
  }

  async health() {
    try {
      const status = await this.request('/api/health');
      return { status: status.status === 'ok' ? 'ready' : 'degraded', version: status.version || null };
    } catch { return { status: 'offline', version: null }; }
  }

  async request(path, options = {}) {
    return this.transport.request(options.method || 'GET', path, options);
  }
}

Object.assign(
  PaperclipBridge.prototype,
  paperclipOrganizationMethods,
  paperclipIssueMethods,
  paperclipM5CaseMethods,
  paperclipPublisherMethods,
);
