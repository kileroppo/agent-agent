import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, configuredCapabilities } from './config.js';
import { makeJob, validatePublicHttpUrl } from './domain.js';
import { canRetryJob, retryPatch } from './recovery.js';
import { createPersistentOneShotFailpoint, resetPersistentOneShotFailpoint } from './test-failpoint.js';
import { IntakeError, createFeishuMediaJob } from './feishu-media-intake.js';
import { MediaPipeline, deliverToLark } from './pipeline.js';
import { JobPauseController, JobPauseError } from './job-pause-controller.js';
import { JobStore } from './store.js';
import { createContentRuntime } from './content-runtime.js';
import { ConnectionInputError } from '../../../integrations/access/connection-store.js';

await fs.mkdir(config.workDir, { recursive: true });
const uploadsDir = path.join(config.workDir, 'uploads');
await fs.mkdir(uploadsDir, { recursive: true });
const store = new JobStore(config.workDir);
await store.init();
const contentRuntime = await createContentRuntime(config.workDir);
const pauseController = new JobPauseController({ store });
const failpointMarkerPath = path.join(config.workDir, '.acceptance-test-failpoint-consumed');
if (!config.testFailOnceAt) await resetPersistentOneShotFailpoint(failpointMarkerPath);
const pipeline = new MediaPipeline({
  store,
  workDir: config.workDir,
  contentCenter: contentRuntime.contentCenter,
  pauseController,
  failpoint: createPersistentOneShotFailpoint(config.testFailOnceAt, failpointMarkerPath)
});
const upload = multer({ dest: uploadsDir, limits: { fileSize: 1024 * 1024 * 1024 } });
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.resolve('public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, capabilities: configuredCapabilities(), commonAccess: contentRuntime.health() }));
app.get('/api/jobs', (_req, res) => res.json({ jobs: store.list() }));
app.get('/api/connections', (_req, res) => res.json({ connections: contentRuntime.connectionStore.list() }));
app.get('/api/operations/events', (_req, res) => res.json({ events: contentRuntime.operations.list() }));
app.get('/api/cookie-bridge/accounts', async (_req, res) => {
  const endpoint = localCookieBridgeAccountsEndpoint(config.mediaCrawler.cookieBridgeUrl);
  if (!endpoint) return res.status(503).json({ error: 'CookieBridge 本机服务未配置。' });
  try {
    const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.isok === false) throw new Error('unavailable');
    const accounts = Array.isArray(payload?.data?.accounts) ? payload.data.accounts : [];
    res.json({ accounts: accounts.map((account) => ({
      clientId: String(account.client_id || ''), connected: Boolean(account.connected),
      platforms: Object.keys(account.platforms || {}), nicknames: account.nicknames && typeof account.nicknames === 'object' ? account.nicknames : {}
    })).filter((account) => account.clientId) });
  } catch {
    res.status(503).json({ error: 'CookieBridge 本机服务暂时不可用。' });
  }
});
app.get('/api/jobs/:id', (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});
app.get('/api/jobs/:id/download', async (req, res, next) => {
  try {
    const job = store.get(req.params.id);
    if (!job?.output?.markdownPath) return res.status(404).json({ error: '整理稿尚未生成' });
    await fs.access(job.output.markdownPath);
    res.download(job.output.markdownPath, `${job.title}-分享式整理稿.md`);
  } catch (error) { next(error); }
});
app.get('/api/jobs/:id/download/:asset', async (req, res, next) => {
  try {
    const job = store.get(req.params.id);
    const assets = {
      guide: ['guidePath', `${job?.title || '整理稿'}-内容导览.md`],
      proofread: ['proofreadPath', `${job?.title || '整理稿'}-完整校对文本.md`]
    };
    const asset = assets[req.params.asset];
    if (!asset || !job?.output?.[asset[0]]) return res.status(404).json({ error: '该交付物尚未生成' });
    await fs.access(job.output[asset[0]]);
    res.download(job.output[asset[0]], asset[1]);
  } catch (error) { next(error); }
});

app.post('/api/jobs', async (req, res, next) => {
  try {
    const valid = validatePublicHttpUrl(req.body?.url || '');
    if (!valid.ok) return res.status(422).json({ error: valid.reason });
    const requestedConnectionId = req.body?.connectionId || null;
    const connectionId = requestedConnectionId || await contentRuntime.resolveConnectionForSource(valid.url);
    if (requestedConnectionId !== null && (typeof requestedConnectionId !== 'string' || !requestedConnectionId.trim())) return res.status(422).json({ error: '连接标识格式不正确。' });
    const job = await store.create(makeJob({ sourceType: 'url', sourceUrl: valid.url, connectionId }));
    void pipeline.run(job.id);
    res.status(202).json({ job });
  } catch (error) { next(error); }
});

app.post('/api/connections/browser-session', async (req, res, next) => {
  try {
    const connection = await contentRuntime.connectionStore.createBrowserSessionConnection(req.body || {});
    res.status(201).json({ connection });
  } catch (error) { next(error); }
});

app.post('/api/connections/cookie-bridge', async (req, res, next) => {
  try {
    const connection = await contentRuntime.connectionStore.createCookieBridgeConnection(req.body || {});
    res.status(201).json({ connection });
  } catch (error) { next(error); }
});

app.post('/api/connections/:id/revoke', async (req, res, next) => {
  try {
    const connection = await contentRuntime.connectionStore.revoke(req.params.id);
    if (!connection) return res.status(404).json({ error: '账号连接不存在。' });
    await contentRuntime.operations.record({ subjectType: 'connection', subjectRef: connection.connectionId, eventType: 'connection_revoked', severity: 'info', safeMessage: '账号连接已撤销，后续任务将要求重新授权。', recommendedAction: 'reauthorize' });
    res.json({ connection });
  } catch (error) { next(error); }
});

app.post('/api/jobs/upload', upload.single('media'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(422).json({ error: '请选择一个音频或视频文件。' });
    const job = await store.create(makeJob({ sourceType: 'upload', originalName: req.file.originalname, sourcePath: req.file.path }));
    void pipeline.run(job.id);
    res.status(202).json({ job });
  } catch (error) { next(error); }
});

app.post('/api/internal/feishu-media', async (req, res, next) => {
  try {
    const result = await createFeishuMediaJob({
      store, uploadsDir, body: req.body, maxBytes: config.inboundMedia.maxBytes, allowedRoots: config.inboundMedia.allowedRoots
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (result.created) void pipeline.run(result.job.id);
    res.status(result.created ? 202 : 200).json({ job: result.job, duplicate: !result.created });
  } catch (error) { next(error); }
});

app.post('/api/jobs/:id/retry', async (req, res, next) => {
  try {
    const job = store.get(req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (!canRetryJob(job)) {
      return res.status(409).json({ error: job.status === 'failed' ? '该任务不能自动重试；请按失败提示补充素材或人工处理。' : '仅失败且可重试的任务可以继续。' });
    }
    await store.update(job.id, retryPatch(job), { stage: 'queued', message: '用户发起安全重试' });
    void pipeline.run(job.id);
    res.status(202).json({ job: store.get(job.id) });
  } catch (error) { next(error); }
});

app.post('/api/jobs/:id/pause', async (req, res, next) => {
  try {
    const job = await pauseController.request(req.params.id);
    res.status(202).json({ job });
  } catch (error) {
    if (error instanceof JobPauseError) return res.status(409).json({ error: error.message });
    next(error);
  }
});

app.post('/api/jobs/:id/resume', async (req, res, next) => {
  try {
    const job = await pauseController.resume(req.params.id);
    void pipeline.run(job.id);
    res.status(202).json({ job });
  } catch (error) {
    if (error instanceof JobPauseError) return res.status(409).json({ error: error.message });
    next(error);
  }
});

app.post('/api/jobs/:id/redeliver', async (req, res, next) => {
  try {
    const job = store.get(req.params.id);
    if (!job?.output?.markdownPath) return res.status(404).json({ error: '该任务没有可重新交付的整理稿。' });
    const markdown = await fs.readFile(job.output.markdownPath, 'utf8');
    const requestedTitle = typeof req.body?.title === 'string' ? req.body.title.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    const title = requestedTitle || job.title;
    const lark = await deliverToLark(title, markdown.replace(/^#\s+[^\n]+/m, `# ${title}`));
    if (lark.configured === false) return res.status(503).json({ error: '飞书交付尚未配置。' });
    await store.update(job.id, { title, output: { ...job.output, larkUrl: lark.url, larkPermissionGranted: lark.permissionGranted || false } }, { stage: 'delivering', message: '已按新版阅读排版重新交付' });
    res.status(201).json({ job: store.get(job.id) });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超过 1GB 上传上限。' });
  if (error instanceof IntakeError) return res.status(error.status).json({ error: error.message });
  if (error instanceof ConnectionInputError) return res.status(422).json({ error: error.message });
  console.error(error instanceof Error ? error.message : 'unknown server error');
  res.status(500).json({ error: '服务发生异常，请查看终端日志。' });
});

app.listen(config.port, config.host, () => console.log(`媒体转录 Agent 已启动：http://${config.host}:${config.port}`));

function localCookieBridgeAccountsEndpoint(value) {
  try {
    const endpoint = new URL('/api/accounts', value);
    return ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname) ? endpoint : null;
  } catch { return null; }
}
