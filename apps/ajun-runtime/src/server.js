import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry } from './agent-registry.js';
import { TaskStore } from './task-store.js';
import { TaskService, ValidationError } from './task-service.js';
import { PaperclipBridge } from './paperclip-bridge.js';
import { LocalHealthOperator } from './local-health-operator.js';
import { LocalTaskCoordinator } from './local-task-coordinator.js';
import { LocalReviewer } from './local-reviewer.js';
import { LocalArchitect } from './local-architect.js';
import { XiaodDelegate } from './xiaod-delegate.js';
import { PaperclipHeartbeatHandler } from './paperclip-heartbeat.js';
import { canAccessApi, isLocalAddress, isLoopbackHost, lanAddresses, loadLanShareKey, rotateLanShareKey } from './lan-access.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const publicDir = path.join(root, 'apps/ajun-runtime/public');
const registry = new AgentRegistry({ agentsDir: path.join(root, 'agents') });
const store = new TaskStore(path.join(root, 'apps/ajun-runtime/data/runtime.json'));
const governance = new PaperclipBridge();
const xiaod = new XiaodDelegate({ onStarted: ({ taskId, xiaodJobId }) => void followXiaod(taskId, xiaodJobId) });
const operator = new LocalHealthOperator({ governance });
const tasks = new TaskService({ registry, store, governance, executors: { operator, xiaod, 'task-coordinator': new LocalTaskCoordinator(), reviewer: new LocalReviewer(), architect: new LocalArchitect({ registry }) } });
const paperclipHeartbeat = new PaperclipHeartbeatHandler({ operator, governance });
const port = Number(process.env.PORT || 4321);
const host = process.env.AJUN_HOST || '0.0.0.0';
const lanEnabled = !isLoopbackHost(host);
const lanAccess = { enabled: lanEnabled, key: await loadLanShareKey(path.join(root, 'apps/ajun-runtime/data/lan-share-key'), lanEnabled) };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/paperclip/heartbeat') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'Paperclip heartbeat 只能由本机服务调用。' });
      return json(res, 202, await paperclipHeartbeat.handle(await body(req)));
    }
    if (req.method === 'GET' && req.url === '/api/local-share') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '共享口令只能在本机查看。' });
      return json(res, 200, { enabled: lanEnabled, addresses: lanEnabled ? lanAddresses() : [], accessKey: lanAccess.key });
    }
    if (req.method === 'POST' && req.url === '/api/local-share/rotate') {
      if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error: '共享口令只能在本机轮换。' });
      lanAccess.key = await rotateLanShareKey(path.join(root, 'apps/ajun-runtime/data/lan-share-key'), lanEnabled);
      return json(res, 200, { enabled: lanEnabled, addresses: lanEnabled ? lanAddresses() : [], accessKey: lanAccess.key });
    }
    if (req.url?.startsWith('/api/') && !canAccessApi(req, lanAccess)) return json(res, 401, { error: '请输入局域网共享口令。' });
    if (req.method === 'GET' && req.url === '/api/overview') return json(res, 200, await tasks.overview());
    if (req.method === 'POST' && req.url === '/api/tasks') { const input = await body(req); if (!isLocalAddress(req.socket.remoteAddress) && !String(input.requesterName || '').trim()) throw new ValidationError('局域网协作者请先填写自己的称呼。'); return json(res, 201, { task: await tasks.create(input) }); }
    const rejectMatch = req.url?.match(/^\/api\/approvals\/([0-9a-f-]+)\/reject$/i);
    if (req.method === 'POST' && rejectMatch) { if (!isLocalAddress(req.socket.remoteAddress)) return json(res, 403, { error:'只有本机主人可以拒绝审批。' }); return json(res, 200, { task: await tasks.rejectApproval(rejectMatch[1]) }); }
    const continueMatch = req.url?.match(/^\/api\/tasks\/([0-9a-f-]+)\/continue$/i);
    if (req.method === 'POST' && continueMatch) return json(res, 201, { task: await tasks.continueFromRecommendation(continueMatch[1]) });
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return file(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/app.js') return file(res, 'app.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/styles.css') return file(res, 'styles.css', 'text/css; charset=utf-8');
    json(res, 404, { error: '未找到该入口。' });
  } catch (error) { json(res, error instanceof ValidationError ? 422 : 500, { error: error.message || '运行台暂时不可用。' }); }
});
server.listen(port, host, () => console.log(`A君运行台：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}${lanEnabled ? '（局域网共享已开启）' : ''}`));

async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; }
async function file(res, name, type) { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(await fs.readFile(path.join(publicDir, name))); }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }

async function followXiaod(taskId, jobId) {
  try {
    const job = await xiaod.getJob(jobId); const task = (await store.list()).find((item) => item.taskId === taskId);
    if (!task) return;
    const status = job.status === 'completed' ? 'succeeded' : job.status === 'failed' ? 'failed' : 'running';
    const patch = {
      status, currentStage: `xiaod_${job.status}`,
      execution: { ...task.execution, xiaodStatus: job.status, xiaodProgress: job.progress, updatedAt: new Date().toISOString() }
    };
    if (status === 'succeeded') patch.artifactRefs = [{ artifactId: `xiaod-job:${job.id}`, taskId, type: 'xiaod_media_delivery', title: job.title, location: `${xiaod.baseUrl}/api/jobs/${job.id}`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: Boolean(job.output?.markdownPath), qualityPassed: Boolean(job.quality?.passed) }, createdAt: new Date().toISOString() }];
    if (status === 'failed') patch.error = { code: 'xiaod_job_failed', message: job.error?.message || '小D任务失败。', userMessage: '小D未能完成素材处理，请根据任务提示补充素材或稍后重试。', category: 'manual', stage: job.status, occurredAt: new Date().toISOString() };
    let updated = await store.updateTask(taskId, patch);
    updated = await store.updateTask(taskId, { governance: await governance.update(updated) });
    if (status === 'running') setTimeout(() => void followXiaod(taskId, jobId), 3000);
  } catch (error) {
    const task = (await store.list()).find((item) => item.taskId === taskId);
    if (!task || task.status !== 'running') return;
    const updated = await store.updateTask(taskId, { status: 'failed', currentStage: 'xiaod_status_unavailable', error: { code: 'xiaod_status_unavailable', message: String(error?.message || '小D状态不可用。'), userMessage: '无法确认小D任务状态，未将其标记为完成。', category: 'manual', stage: 'delegated_to_xiaod', occurredAt: new Date().toISOString() } });
    await store.updateTask(taskId, { governance: await governance.update(updated) });
  }
}
