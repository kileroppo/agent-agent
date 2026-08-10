export class ProposalAgentRegistry {
  constructor({ baseRegistry, store } = {}) {
    this.baseRegistry = baseRegistry;
    this.store = store;
  }

  async list(options = {}) {
    return this.baseRegistry.list(options);
  }

  async get(agentId, options = {}) { return this.baseRegistry.get(agentId, options); }

  async candidates(taskType) {
    return (await this.list({ includeManagers:true }))
      .filter((agent) => agent.acceptedTaskTypes.includes(taskType));
  }

  async runtimeProfile(manifest) {
    return typeof this.baseRegistry?.runtimeProfile === 'function'
      ? this.baseRegistry.runtimeProfile(manifest)
      : null;
  }

  async formal(agentId) { return this.baseRegistry.get(agentId, { includeInactive:true, includeManagers:true }); }
}
