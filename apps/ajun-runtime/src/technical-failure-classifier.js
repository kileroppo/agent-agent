const AUTH_RE = /(?:auth|unauthor|forbidden|permission|credential|cookie|token|login|billing|credits?|balance|quota|entitlement|http 402|授权|登录|权限|余额|额度)/i;
const TRANSIENT_RE = /(?:timeout|timed out|temporar|rate.?limit|unavailable|connection|network|econn|限流|超时|网络|暂时不可用)/i;
const CODE_RE = /(?:assert|typeerror|referenceerror|syntaxerror|test.?fail|coverage_below|checksum|schema|invalid state|完整性检查|校验失败)/i;
const INPUT_RE = /(?:needs_input|missing input|unsupported media|重新上传|补充|无法识别为可转录|缺少.*(?:输入|材料|文件))/i;

export function classifyTechnicalFailure({ error = {}, taskType = '', sourceUrl = '' } = {}) {
  const code = String(error.code || 'unknown_failure');
  const category = String(error.category || 'manual');
  const stage = String(error.stage || 'unknown');
  const message = sanitizeFailureText(error.userMessage || error.message || '');
  const combined = `${code} ${category} ${stage} ${message}`;
  let failureClass = 'unknown';
  let route = 'diagnose_before_action';
  let reason = '现有脱敏证据不足，先只读定位，不直接修改代码。';
  if (AUTH_RE.test(combined)) {
    failureClass = 'authorization_or_permission';
    route = 'needs_authorized_input';
    reason = '故障涉及授权或权限，技术专家只能定位边界，不能绕过授权修复。';
  } else if (category === 'needs_input' || INPUT_RE.test(combined)) {
    failureClass = 'input_or_source';
    route = 'needs_input_or_adapter_evidence';
    reason = '当前更像输入、素材或适配器证据不足，先补最小证据，不猜测改代码。';
  } else if (error.retryable === true || TRANSIENT_RE.test(combined)) {
    failureClass = 'transient_external_dependency';
    route = 'operator_retry_then_diagnose';
    reason = '当前更像临时外部依赖故障，先使用一次安全重试，重试用尽后再诊断。';
  } else if (CODE_RE.test(combined) || code === 'executor_failed') {
    failureClass = 'code_defect_candidate';
    route = 'read_only_code_diagnosis';
    reason = '现有证据指向可复现的代码或质量门禁缺陷，可进入只读代码定位。';
  }
  return {
    schemaVersion:'agent.army/technical-failure-classification/v1',
    failureClass,
    route,
    reason,
    evidence:{
      code,
      category,
      stage,
      message,
      taskType:String(taskType || 'unknown').slice(0, 120),
      sourcePlatform:sourcePlatform(sourceUrl)
    }
  };
}

export function sanitizeFailureText(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[链接已脱敏]')
    .replace(/\b(?:authorization|token|cookie|secret|password|key)\s*[:=]\s*[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

function sourcePlatform(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    if (host.includes('bilibili.com') || host === 'b23.tv') return 'bilibili';
    if (host.includes('douyin.com')) return 'douyin';
    if (host.includes('xiaohongshu.com') || host === 'xhslink.com') return 'xiaohongshu';
    return host ? 'public-web' : null;
  } catch {
    return null;
  }
}
