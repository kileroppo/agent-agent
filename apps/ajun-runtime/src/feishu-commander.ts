import { feishuCommanderContextMethods } from './feishu-commander-context.ts';
import { feishuCommanderFollowupMethods } from './feishu-commander-followup.ts';
import { FeishuCommanderValidationError, safeLoopbackBaseUrl, } from './feishu-commander-replies.ts';
import { feishuCommanderRoutingMethods } from './feishu-commander-routing.ts';
export { FeishuCommanderValidationError };
export class FeishuCommander {
    ajunBaseUrl: any;
    conversationAdvisor: any;
    missions: any;
    planner: any;
    proposals: any;
    store: any;
    tasks: any;
    constructor({ tasks, proposals, missions = null, store, planner = null, conversationAdvisor = null, ajunBaseUrl = null, }: any = {}) {
        this.tasks = tasks;
        this.proposals = proposals;
        this.missions = missions;
        this.store = store;
        this.planner = planner;
        this.conversationAdvisor = conversationAdvisor;
        this.ajunBaseUrl = safeLoopbackBaseUrl(ajunBaseUrl);
    }
}
for (const methods of [
    feishuCommanderRoutingMethods,
    feishuCommanderFollowupMethods,
    feishuCommanderContextMethods,
]) {
    Object.defineProperties(FeishuCommander.prototype, Object.fromEntries(Object.entries(methods).map(([name, value]: any): any => [name, {
            configurable: true,
            enumerable: false,
            value,
            writable: true,
        }])));
}
