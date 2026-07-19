const jobsEl = document.querySelector('#jobs');
const emptyEl = document.querySelector('#empty-state');
const messageEl = document.querySelector('#form-message');
const template = document.querySelector('#job-template');

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((tab) => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
  document.querySelector('#url-form').classList.toggle('hidden', button.dataset.source !== 'url');
  document.querySelector('#upload-form').classList.toggle('hidden', button.dataset.source !== 'upload');
  setMessage('');
}));
document.querySelector('#url-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = new FormData(event.currentTarget).get('url');
  await submit('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
});
document.querySelector('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit('/api/jobs/upload', { method: 'POST', body: new FormData(event.currentTarget) });
});
document.querySelector('#refresh').addEventListener('click', loadJobs);

async function submit(url, options) {
  setMessage('正在创建任务…');
  try {
    const response = await fetch(url, options); const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建任务失败');
    setMessage('任务已开始，处理进度会显示在下方。');
    document.querySelector('#url-form').reset(); document.querySelector('#upload-form').reset();
    await loadJobs();
  } catch (error) { setMessage(error.message, true); }
}

async function loadJobs() {
  const response = await fetch('/api/jobs');
  const { jobs } = await response.json();
  emptyEl.hidden = jobs.length > 0; jobsEl.replaceChildren();
  jobs.forEach(renderJob);
}

function renderJob(job) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.querySelector('.job-title').textContent = job.title;
  const status = card.querySelector('.status'); status.textContent = statusLabel(job.status); status.classList.add(job.status);
  card.querySelector('.job-source').textContent = job.sourceType === 'upload' ? `本地文件 · ${job.originalName}` : job.sourceUrl;
  card.querySelector('.progress-bar').style.width = `${job.progress}%`;
  card.querySelector('.stage-message').textContent = job.stageMessage;
  const warnings = card.querySelector('.warnings');
  if (job.error) { const p = document.createElement('p'); p.className = 'error'; p.textContent = job.error; warnings.append(p); }
  job.warnings.forEach((warning) => { const p = document.createElement('p'); p.className = 'warning'; p.textContent = warning; warnings.append(p); });
  const actions = card.querySelector('.job-actions');
  if (job.output?.markdownPath) { const link = document.createElement('a'); link.className = 'link-button'; link.href = `/api/jobs/${job.id}/download`; link.textContent = '完整整理稿'; actions.append(link); }
  if (job.output?.guidePath) { const link = document.createElement('a'); link.className = 'link-button'; link.href = `/api/jobs/${job.id}/download/guide`; link.textContent = '内容导览'; actions.append(link); }
  if (job.output?.proofreadPath) { const link = document.createElement('a'); link.className = 'link-button'; link.href = `/api/jobs/${job.id}/download/proofread`; link.textContent = '校对文本'; actions.append(link); }
  if (job.output?.larkUrl) { const link = document.createElement('a'); link.className = 'link-button'; link.href = job.output.larkUrl; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = '打开飞书'; actions.append(link); }
  if (['failed', 'completed'].includes(job.status)) { const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = '重新处理'; retry.onclick = () => retryJob(job.id); actions.append(retry); }
  const log = card.querySelector('.job-log ol'); job.log.slice().reverse().forEach((item) => { const li = document.createElement('li'); li.textContent = `${new Date(item.at).toLocaleString()} · ${item.message}`; log.append(li); });
  jobsEl.append(card);
}

async function retryJob(id) { const response = await fetch(`/api/jobs/${id}/retry`, { method: 'POST' }); const data = await response.json(); if (!response.ok) return setMessage(data.error || '无法重试', true); setMessage('任务已重新进入队列。'); loadJobs(); }
function statusLabel(status) { return ({ queued:'等待中', preparing:'检查素材', acquiring:'获取素材', transcribing:'转录中', distilling:'整理中', delivering:'交付中', completed:'已完成', failed:'失败' })[status] || status; }
function setMessage(message, isError = false) { messageEl.textContent = message; messageEl.classList.toggle('error', isError); }

async function loadHealth() { const response = await fetch('/api/health'); const { capabilities } = await response.json(); const el = document.querySelector('#capabilities'); const labels = { asr:'本地 ASR', aiRefinement:'语义整理', lark:'飞书交付' }; Object.entries(capabilities).forEach(([key, value]) => { const badge = document.createElement('span'); badge.className = `capability ${value ? 'ready' : ''}`; badge.textContent = `${labels[key]} · ${value ? '已配置' : '未配置'}`; el.append(badge); }); }
await Promise.all([loadHealth(), loadJobs()]);
setInterval(loadJobs, 3000);
