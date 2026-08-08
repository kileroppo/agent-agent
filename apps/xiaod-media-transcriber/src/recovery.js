export function classifyFailure(error) {
  if (error?.accessFailure) {
    return {
      category: error.accessFailure.category || 'manual',
      retryable: error.accessFailure.category === 'retryable',
      recovery: error.accessFailure.safeMessage
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === 'lark_delivery_uncertain') return larkDeliveryUncertainFailure();
  if (error?.code === 'visual_evidence_required' || error?.code === 'visual_video_stream_required') {
    return {
      category:'needs_input',
      retryable:false,
      recovery:'本次任务要求画面分析，但没有取得可用视频。请补充本地视频、完成所需授权或改用自动模式。'
    };
  }
  if (/^ffmpeg 执行失败|Error opening input|Invalid data found/i.test(message)) {
    return {
      category: 'needs_input',
      retryable: false,
      recovery: '素材无法被识别为可转录的音视频文件，请重新上传原始音频或视频文件。'
    };
  }
  if (/服务重启导致任务中断|无法启动|执行失败|ASR 已运行但没有生成/i.test(message)) {
    return {
      category: 'retryable',
      retryable: true,
      recovery: '可在飞书回复“重试小D任务”从安全断点继续，无需重复上传。'
    };
  }
  return {
    category: 'manual',
    retryable: false,
    recovery: '请保留任务编号并联系维护者检查；请勿重复上传。'
  };
}

export function larkDeliveryUncertainFailure() {
  return {
    category:'manual',
    retryable:false,
    recovery:'飞书可能已收到本次交付。请先按任务编号核对飞书文档；在确认前不要重试，以免生成重复文档。'
  };
}

export function knownLarkDeliveryRecoveryPatch(job) {
  const delivery = job?.output?.larkDelivery;
  if (!job?.output?.markdownPath || !delivery) return null;
  const output = {
    ...job.output,
    larkUrl:delivery.url || job.output.larkUrl || null,
    larkPermissionGranted:delivery.permissionGranted === true
  };
  if (delivery.state === 'delivered') {
    const reviewPending = job.output.reviewStatus === 'awaiting_review';
    return {
      status:reviewPending ? 'awaiting_review' : 'completed',
      progress:reviewPending ? 92 : 100,
      stageMessage:reviewPending ? '飞书交付已确认，等待人工完整听审' : '飞书交付凭据已恢复，任务已完成',
      completedAt:reviewPending ? null : delivery.completedAt || new Date().toISOString(),
      error:null,
      failure:null,
      output
    };
  }
  if (['document_ready', 'failed_before_create'].includes(delivery.state)) {
    return {
      status:'awaiting_delivery',
      progress:92,
      stageMessage:delivery.state === 'document_ready'
        ? '飞书文档已创建，等待权限确认'
        : '本地交付物已完成，等待飞书配置',
      completedAt:null,
      error:null,
      failure:null,
      output
    };
  }
  return null;
}

export function interruptedByRestartFailure() {
  return {
    category: 'retryable',
    retryable: true,
    recovery: '服务已恢复，可在飞书回复“重试小D任务”从安全断点继续，无需重复上传。'
  };
}

export function canRetryJob(job) {
  return job?.status === 'failed' && job.failure?.retryable === true;
}

export function retryPatch(job) {
  return {
    status: 'queued',
    progress: 0,
    error: null,
    failure: null,
    warnings: [],
    quality: null,
    stageMessage: '已从安全断点重新进入队列',
    attempts: [...(job.attempts || []), {
      at: new Date().toISOString(),
      kind: 'retry',
      previousError: job.error || null
    }]
  };
}
