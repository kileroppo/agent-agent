export class CloudXiaodExecutor {
  async execute(task) {
    const sourceUrl = String(task.input?.sourceUrl || '').trim();
    if (!sourceUrl) return {
      status:'needs_input',
      currentStage:'source_url_required',
      routing:{ ...(task.routing || {}), reason:'请补充一个公开 HTTP(S) 素材链接后再交给小D。' }
    };
    return {
      status:'waiting_worker',
      currentStage:'waiting_for_mac_worker',
      execution:{
        executor:'xiaod',
        mode:'mac_worker',
        startedAt:new Date().toISOString(),
        sourceUrl,
        worker:{ state:'waiting' }
      },
      usage:{ tools:[{ id:'mac-worker-queue', name:'Mac工作间安全接力', calls:1 }] },
      artifactRefs:[]
    };
  }
}
