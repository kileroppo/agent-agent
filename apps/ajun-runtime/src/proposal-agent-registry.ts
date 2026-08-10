export class ProposalAgentRegistry {
  baseRegistry: any; store: any;
  constructor({ baseRegistry, store }: any = {}) {
    this.baseRegistry = baseRegistry;
    this.store = store;
  }

  async list(options: any = {}) {
    return this.baseRegistry.list(options);
  }

  async get(agentId: string, options: any = {}) { return this.baseRegistry.get(agentId, options); }

  async candidates(taskType: string) {
    return (await this.list({ includeManagers:true }))
      .filter((agent: any) => agent.acceptedTaskTypes.includes(taskType));
  }

  async runtimeProfile(manifest: any) {
    return typeof this.baseRegistry?.runtimeProfile === 'function'
      ? this.baseRegistry.runtimeProfile(manifest)
      : null;
  }

  async formal(agentId: string) { return this.baseRegistry.get(agentId, { includeInactive:true, includeManagers:true }); }
}
