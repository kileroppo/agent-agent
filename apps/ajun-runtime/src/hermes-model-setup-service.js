import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class HermesModelSetupService {
  constructor({
    command = process.env.AJUN_HERMES_COMMAND || path.join(os.homedir(), '.local', 'bin', 'hermes'),
    profileRoot = process.env.AGENT_ARMY_HERMES_PROFILE_ROOT || path.join(os.homedir(), '.hermes/profiles'),
    dashboardOrigin = 'http://127.0.0.1:9119',
    fetchImpl = fetch,
    spawnProcess = spawn,
    stat = fs.stat,
    resolveProfile = async () => null,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    startupAttempts = 24,
    startupDelayMs = 125
  } = {}) {
    this.command = command;
    this.profileRoot = path.resolve(profileRoot);
    this.hermesHome = path.dirname(this.profileRoot);
    this.dashboardOrigin = normalizeLoopbackOrigin(dashboardOrigin);
    this.fetchImpl = fetchImpl;
    this.spawnProcess = spawnProcess;
    this.stat = stat;
    this.resolveProfile = resolveProfile;
    this.sleep = sleep;
    this.startupAttempts = startupAttempts;
    this.startupDelayMs = startupDelayMs;
    this.starting = null;
  }

  async open(agentId) {
    const id = String(agentId || '').trim();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new HermesModelSetupError('员工标识格式不正确。');
    const profile = String(await this.resolveProfile(id) || '').trim();
    if (profile && !/^[a-z][a-z0-9-]{0,63}$/.test(profile)) throw new HermesModelSetupError('员工 Profile 标识无效。');
    if (!profile) throw new HermesModelSetupError('这名员工没有独立 Hermes Profile，不能打开模型授权。');
    await this.assertProfile(profile);
    await this.ensureDashboard(profile);
    const encoded = encodeURIComponent(profile);
    return {
      agentId:id,
      status:'ready_for_authorization',
      url:`${this.dashboardOrigin}/env?profile=${encoded}`,
      modelUrl:`${this.dashboardOrigin}/models?profile=${encoded}`,
      message:'Hermes 官方授权页已锁定到这名员工的 Profile；不会自动更改其他员工的模型配置。'
    };
  }

  async assertProfile(profile) {
    const profilePath = path.resolve(this.profileRoot, profile);
    if (!profilePath.startsWith(`${this.profileRoot}${path.sep}`)) throw new HermesModelSetupError('员工 Profile 路径无效。');
    try {
      const info = await this.stat(profilePath);
      if (!info.isDirectory()) throw new Error('not-directory');
    } catch {
      throw new HermesModelSetupError('这名员工的 Hermes Profile 尚未建立，不能开始授权。');
    }
  }

  async ensureDashboard(profile) {
    const initial = await this.probe(profile);
    if (initial.compatible) return;
    if (initial.reachable) throw new HermesModelSetupError('Hermes 授权端口已被其他本机服务占用，请先关闭占用 9119 端口的程序。');

    if (!this.starting) {
      this.starting = Promise.resolve().then(() => this.startDashboard()).finally(() => { this.starting = null; });
    }
    await this.starting;
    for (let attempt = 0; attempt < this.startupAttempts; attempt += 1) {
      await this.sleep(this.startupDelayMs);
      const current = await this.probe(profile);
      if (current.compatible) return;
      if (current.reachable) throw new HermesModelSetupError('Hermes 授权页已启动，但没有识别到这名员工的独立 Profile。');
    }
    throw new HermesModelSetupError('Hermes 授权页暂时没有启动成功，请稍后再试。');
  }

  startDashboard() {
    const child = this.spawnProcess(this.command, [
      'dashboard',
      '--host', '127.0.0.1',
      '--port', new URL(this.dashboardOrigin).port,
      '--no-open',
      '--skip-build'
    ], {
      detached:true,
      stdio:'ignore',
      env:{ ...process.env, HERMES_HOME:this.hermesHome, NO_COLOR:'1' }
    });
    child.on?.('error', () => {});
    child.unref?.();
  }

  async probe(profile) {
    try {
      const response = await this.fetchImpl(`${this.dashboardOrigin}/api/status`, {
        signal:AbortSignal.timeout(900),
        headers:{ accept:'application/json' }
      });
      if (!response.ok) return { reachable:true, compatible:false };
      const payload = await response.json();
      return {
        reachable:true,
        compatible:Boolean(payload?.version && Array.isArray(payload?.profiles) && payload.profiles.includes(profile))
      };
    } catch {
      return { reachable:false, compatible:false };
    }
  }
}

export class HermesModelSetupError extends Error {}

function normalizeLoopbackOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d{2,5}$/.test(url.port) || url.pathname !== '/') {
    throw new HermesModelSetupError('Hermes 授权页必须使用固定的本机回环地址。');
  }
  return url.origin;
}
