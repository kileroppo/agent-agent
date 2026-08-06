import test from 'node:test';
import assert from 'node:assert/strict';
import { JobPauseController, JobPausedError } from '../src/job-pause-controller.js';

function fixture(status = 'transcribing') {
  const job = { id:'job-1', status, progress:45, stageMessage:'正在转录', log:[] };
  const store = {
    get(id) { return id === job.id ? job : null; },
    async update(id, patch, log) { assert.equal(id, job.id); Object.assign(job, patch); if (log) job.log.push(log); return job; }
  };
  return { job, controller:new JobPauseController({ store, now:() => new Date('2026-07-22T12:00:00.000Z') }) };
}

test('正在处理的小D任务先显示正在暂停，到安全位置后才真的暂停', async () => {
  const { job, controller } = fixture();
  await controller.request('job-1');
  assert.equal(job.status, 'pausing');
  await assert.rejects(controller.checkpoint('job-1', '转录完成'), JobPausedError);
  assert.equal(job.status, 'paused');
  assert.equal(job.pause.safePoint, '转录完成');
  assert.match(job.stageMessage, /已暂停/);
});

test('队列里的小D任务会在开始前直接暂停，继续后回到可执行队列', async () => {
  const { job, controller } = fixture('queued');
  await controller.request('job-1');
  assert.equal(job.status, 'paused');
  await controller.resume('job-1');
  assert.equal(job.status, 'queued');
  assert.match(job.stageMessage, /已继续/);
  assert.equal(await controller.checkpoint('job-1', '重新开始前'), false);
});

test('已经完成的任务不允许伪装成可以暂停', async () => {
  const { controller } = fixture('completed');
  await assert.rejects(controller.request('job-1'), /尚未完成/);
});
