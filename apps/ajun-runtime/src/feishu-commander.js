import { feishuCommanderContextMethods } from './feishu-commander-context.js';
import { feishuCommanderFollowupMethods } from './feishu-commander-followup.js';
import {
  FeishuCommanderValidationError,
  safeLoopbackBaseUrl,
} from './feishu-commander-replies.js';
import { feishuCommanderRoutingMethods } from './feishu-commander-routing.js';

export { FeishuCommanderValidationError };

export class FeishuCommander {
  constructor({
    tasks,
    proposals,
    missions = null,
    store,
    planner = null,
    conversationAdvisor = null,
    ajunBaseUrl = null,
  } = {}) {
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
  Object.defineProperties(
    FeishuCommander.prototype,
    Object.fromEntries(Object.entries(methods).map(([name, value]) => [name, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    }])),
  );
}
