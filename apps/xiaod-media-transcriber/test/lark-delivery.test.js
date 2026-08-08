import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeJob } from '../src/domain.js';
import { LarkDeliveryCoordinator, deliverToLark } from '../src/lark-delivery.js';
import { JobStore } from '../src/store.js';

const TITLE = '稳定性交付测试';
const MARKDOWN = '# 稳定性交付测试\n\n## 内容导览\n\n正文内容。';
const LARK = { appId:'fake-app', appSecret:'fake-secret', userOpenId:'fake-user' };

test('同一交付成功落账后即使进程重建也只创建一个飞书文档', async () => {
  await withStore(async ({ store, job }) => {
    const fake = fakeLarkFetch();
    const transport = transportWith(fake.fetch);
    const first = new LarkDeliveryCoordinator({ store, transport });
    const result = await first.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN });
    assert.equal(result.permissionGranted, true);
    assert.equal(fake.createRequests, 1);

    const afterRestart = new LarkDeliveryCoordinator({ store, transport });
    const duplicate = await afterRestart.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN });
    assert.equal(duplicate.url, result.url);
    assert.equal(fake.createRequests, 1);
    assert.equal(store.get(job.id).output.larkDelivery.state, 'delivered');
  });
});

test('并发提交同一任务共享单飞结果，不会并发创建两个文档', async () => {
  await withStore(async ({ store, job }) => {
    const fake = fakeLarkFetch({ delayCreate:true });
    const delivery = new LarkDeliveryCoordinator({ store, transport:transportWith(fake.fetch) });
    const [first, second] = await Promise.all([
      delivery.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN }),
      delivery.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN })
    ]);
    assert.equal(first.url, second.url);
    assert.equal(fake.createRequests, 1);
  });
});

test('创建文档请求发出后响应丢失会落成不确定状态，并禁止重试重复创建', async () => {
  await withStore(async ({ store, job }) => {
    const fake = fakeLarkFetch({ loseCreateResponse:true });
    const transport = transportWith(fake.fetch);
    const delivery = new LarkDeliveryCoordinator({ store, transport });
    await assert.rejects(
      delivery.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN }),
      (error) => error.code === 'lark_delivery_uncertain'
    );
    assert.equal(fake.createRequests, 1);
    assert.equal(store.get(job.id).output.larkDelivery.state, 'uncertain');
    assert.equal(store.get(job.id).output.larkDelivery.safeToRetry, false);

    const afterRestart = new LarkDeliveryCoordinator({ store, transport });
    await assert.rejects(
      afterRestart.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN }),
      (error) => error.code === 'lark_delivery_uncertain'
    );
    assert.equal(fake.createRequests, 1);
  });
});

test('创建文档请求超时会被中止并按不确定结果处理，不会无限挂住任务', async () => {
  await withStore(async ({ store, job }) => {
    let createRequests = 0;
    const fetchImpl = async (url, options = {}) => {
      if (String(url).includes('tenant_access_token')) return response({ tenant_access_token:'fake-token' });
      createRequests += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once:true });
      });
    };
    const transport = (title, markdown, options) => deliverToLark(title, markdown, {
      ...options, fetchImpl, lark:LARK, timeoutMs:5
    });
    const delivery = new LarkDeliveryCoordinator({ store, transport });
    await assert.rejects(
      delivery.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN }),
      (error) => error.code === 'lark_delivery_uncertain'
    );
    assert.equal(createRequests, 1);
    assert.equal(store.get(job.id).output.larkDelivery.state, 'uncertain');
  });
});

test('飞书成功后本地凭据落账失败会保留不确定标记，后续不再创建新文档', async () => {
  await withStore(async ({ store, job }) => {
    const fake = fakeLarkFetch();
    const delivery = new LarkDeliveryCoordinator({ store, transport:transportWith(fake.fetch) });
    const update = store.update.bind(store);
    let failDeliveredPersistOnce = true;
    store.update = async (id, patch, log) => {
      if (failDeliveredPersistOnce && patch.output?.larkDelivery?.state === 'delivered') {
        failDeliveredPersistOnce = false;
        throw new Error('simulated receipt disk failure');
      }
      return update(id, patch, log);
    };
    await assert.rejects(
      delivery.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN }),
      (error) => error.code === 'lark_delivery_uncertain'
    );
    assert.equal(fake.createRequests, 1);
    assert.equal(store.get(job.id).output.larkDelivery.state, 'uncertain');
    const resolved = await delivery.resolve({
      jobId:job.id,
      decision:'confirmed_delivered',
      permissionGranted:true,
      confirmation:job.id
    });
    assert.equal(resolved.permissionGranted, true);
    assert.equal(store.get(job.id).output.larkDelivery.state, 'delivered');
    await assert.rejects(
      delivery.resolve({ jobId:job.id, decision:'confirmed_not_created', confirmation:job.id }),
      (error) => error.code === 'lark_delivery_resolution_invalid'
    );
    await delivery.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN });
    assert.equal(fake.createRequests, 1);
  });
});

test('只有完整任务编号确认未创建后，才允许不确定交付重新发送', async () => {
  await withStore(async ({ store, job }) => {
    const lost = fakeLarkFetch({ loseCreateResponse:true });
    const first = new LarkDeliveryCoordinator({ store, transport:transportWith(lost.fetch) });
    await assert.rejects(first.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN }));
    await assert.rejects(
      first.resolve({ jobId:job.id, decision:'confirmed_not_created', confirmation:'wrong-job' }),
      (error) => error.status === 422
    );
    await first.resolve({ jobId:job.id, decision:'confirmed_not_created', confirmation:job.id });
    assert.equal(store.get(job.id).output.larkDelivery.state, 'failed_before_create');

    const recovered = fakeLarkFetch();
    const retry = new LarkDeliveryCoordinator({ store, transport:transportWith(recovered.fetch) });
    await retry.deliver({ jobId:job.id, title:TITLE, markdown:MARKDOWN });
    assert.equal(recovered.createRequests, 1);
  });
});

test('服务重启发现已进入外部创建阶段时改为人工核对，不宣称可安全重试', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-lark-restart-'));
  try {
    await fs.writeFile(path.join(root, 'jobs.json'), JSON.stringify([{
      id:'job-restart', status:'delivering', createdAt:'2026-08-08T00:00:00.000Z', updatedAt:'2026-08-08T00:00:00.000Z',
      output:{ larkDelivery:{ state:'creating_document', checksum:'fake', safeToRetry:false } }, log:[]
    }]));
    const store = new JobStore(root);
    await store.init();
    const recovered = store.get('job-restart');
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.failure.retryable, false);
    assert.match(recovered.failure.recovery, /不要重试/);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

function transportWith(fetchImpl) {
  return (title, markdown, options) => deliverToLark(title, markdown, {
    ...options, fetchImpl, lark:LARK, timeoutMs:50
  });
}

function fakeLarkFetch({ loseCreateResponse = false, delayCreate = false } = {}) {
  let createRequests = 0;
  const fetch = async (url) => {
    const target = String(url);
    if (target.includes('tenant_access_token')) return response({ tenant_access_token:'fake-token' });
    if (target.endsWith('/docx/v1/documents')) {
      createRequests += 1;
      if (delayCreate) await new Promise((resolve) => setTimeout(resolve, 5));
      if (loseCreateResponse) throw new Error('socket closed after provider accepted request');
      return response({ data:{ document:{ document_id:`fake-doc-${createRequests}` } } });
    }
    return response({ data:{} });
  };
  return { fetch, get createRequests() { return createRequests; } };
}

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json:async () => payload };
}

async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-lark-delivery-'));
  try {
    const store = new JobStore(root);
    await store.init();
    const job = await store.create(makeJob({ sourceType:'url', sourceUrl:'https://example.com/media', deliveryMode:'feishu' }));
    await run({ root, store, job });
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
}
