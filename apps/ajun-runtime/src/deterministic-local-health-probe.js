const REGISTERED_HTTP_CHECKS = Object.freeze([
  Object.freeze({
    id:'ajun-runtime',
    name:'A君运行台',
    port:4321,
    path:'/api/overview',
    contract:'ajun-overview/v1',
    healthyDetail:'运行状态接口可读。',
    degradedDetail:'A君运行状态接口不可读；未执行重启、登录或配置修改。',
    verify(body) {
      return Boolean(body && Array.isArray(body.agents) && Array.isArray(body.tasks));
    },
    summarize(body) {
      const focus = body.taskFocus || {};
      const active = Number(focus.inProgress || 0);
      const paused = Number(focus.paused || 0);
      const waiting = Number(focus.waitingApproval || 0) + Number(focus.waitingTest || 0);
      return `运行正常；${Number(body.agents.length)} 名员工可用，${active} 项处理中${paused ? `，${paused} 项已暂停` : ''}${waiting ? `，${waiting} 项等待确认或测试` : ''}。`;
    },
    recoverySteps:[
      '确认 127.0.0.1:4321 仍由已登记的 A君运行台监听。',
      '仅重试一次固定的 /api/overview 只读检查。',
      '仍不可读时保留探测证据并升级技术专家。'
    ]
  }),
  Object.freeze({
    id:'xiaod',
    name:'小D素材处理',
    port:4318,
    path:'/api/health',
    contract:'xiaod-health/v1',
    healthyDetail:'本机服务正常；可接收公开素材任务。',
    degradedDetail:'小D健康接口不可读；已保留任务记录，不会自动发起外部动作。',
    verify(body) {
      return body?.ok === true;
    },
    recoverySteps:[
      '确认 127.0.0.1:4318 仍由已登记的小D服务监听。',
      '仅重试一次固定的 /api/health 只读检查。',
      '仍不健康时保留 checkpoint 并升级技术专家。'
    ]
  })
]);

const CHECK_BY_ID = new Map(REGISTERED_HTTP_CHECKS.map((check) => [check.id, check]));

export class DeterministicLocalHealthProbe {
  constructor({ fetchImpl = fetch, timeoutMs = 2500, now = () => new Date() } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('本机健康探针需要受控 HTTP 读取能力。');
    this.fetch = fetchImpl;
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.now = now;
  }

  registeredChecks() {
    return REGISTERED_HTTP_CHECKS.map(publicCheck);
  }

  async check() {
    return Promise.all(REGISTERED_HTTP_CHECKS.map((target) => this.#checkRegistered(target)));
  }

  async checkOne(targetId) {
    const target = CHECK_BY_ID.get(String(targetId || ''));
    if (!target) throw new Error('本机健康探针拒绝未登记目标。');
    return this.#checkRegistered(target);
  }

  async #checkRegistered(target) {
    const checkedAt = this.now().toISOString();
    const endpoint = registeredEndpoint(target);
    const startedAt = Date.now();
    try {
      const response = await this.fetch(endpoint, {
        method:'GET',
        headers:{ accept:'application/json' },
        redirect:'error',
        signal:AbortSignal.timeout(this.timeoutMs)
      });
      const body = await response.json().catch(() => null);
      const contractSatisfied = response.ok === true && target.verify(body);
      if (!contractSatisfied) {
        return degradedObservation({
          target,
          checkedAt,
          latencyMs:elapsed(startedAt),
          httpStatus:finiteStatus(response.status),
          errorCode:response.ok === true ? 'invalid_health_contract' : 'health_http_error'
        });
      }
      return {
        schemaVersion:'agent.army/local-health-observation/v1',
        id:target.id,
        name:target.name,
        status:'healthy',
        detail:target.summarize ? target.summarize(body) : target.healthyDetail,
        checkedAt,
        target:publicCheck(target),
        evidence:{
          kind:'registered_http_health',
          httpStatus:finiteStatus(response.status) || 200,
          latencyMs:elapsed(startedAt),
          contract:target.contract,
          contractSatisfied:true
        },
        recovery:{
          action:'none',
          automaticActionAuthorized:false,
          nextOwner:'operator',
          recommendation:'无需恢复动作。',
          steps:[]
        }
      };
    } catch (error) {
      return degradedObservation({
        target,
        checkedAt,
        latencyMs:elapsed(startedAt),
        httpStatus:null,
        errorCode:error?.name === 'TimeoutError' ? 'health_timeout' : 'health_unreachable'
      });
    }
  }
}

function degradedObservation({ target, checkedAt, latencyMs, httpStatus, errorCode }) {
  return {
    schemaVersion:'agent.army/local-health-observation/v1',
    id:target.id,
    name:target.name,
    status:'degraded',
    detail:target.degradedDetail,
    checkedAt,
    target:publicCheck(target),
    evidence:{
      kind:'registered_http_health',
      httpStatus,
      latencyMs,
      contract:target.contract,
      contractSatisfied:false,
      errorCode
    },
    recovery:{
      action:'verify_registered_service',
      automaticActionAuthorized:false,
      nextOwner:'operator',
      recommendation:`按登记步骤复核${target.name}；禁止执行任意命令或修改账号、凭据和外部连接。`,
      steps:[...target.recoverySteps]
    }
  };
}

function publicCheck(target) {
  return {
    targetId:target.id,
    transport:'http',
    host:'127.0.0.1',
    port:target.port,
    path:target.path,
    method:'GET',
    contract:target.contract
  };
}

function registeredEndpoint(target) {
  return `http://127.0.0.1:${target.port}${target.path}`;
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 10_000) {
    throw new Error('本机健康探针超时必须在 100 到 10000 毫秒之间。');
  }
  return Math.round(parsed);
}

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function finiteStatus(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}
