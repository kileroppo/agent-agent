export function classifyFailure(error) {
  if (error?.accessFailure) {
    return {
      category: error.accessFailure.category || 'manual',
      retryable: false,
      recovery: error.accessFailure.safeMessage
    };
  }
  const message = error instanceof Error ? error.message : String(error);
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
