import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskTimelineLoader,
  renderTaskTimeline,
} from '../public/task-timeline-view.js';

const taskId = '11111111-1111-4111-8111-111111111111';

test('任务时间线默认展示业务过程并把排障信息折叠', () => {
  const html = renderTaskTimeline({
    filters:['fallback'], nextCursor:'next',
    items:[{
      title:'已切换备用能力', summary:'系统已经继续处理。', tone:'warning', occurredAt:'2026-08-13T02:00:00.000Z',
      technical:{ capabilityId:'vision.analyze', provider:'provider-b', durationMs:1200, errorCode:'provider_unavailable' },
    }],
  });
  assert.match(html, /<details class="record-detail-section task-timeline" data-task-timeline open>/);
  assert.match(html, /过程[\s\S]*1/);
  assert.match(html, /已切换备用能力/);
  assert.match(html, /仅看：切换/);
  assert.match(html, /<details class="record-technical task-timeline-technical"><summary>技术详情<\/summary>/);
  assert.match(html, /vision\.analyze/);
  assert.match(html, /继续加载/);
});

test('时间线渲染会转义运行内容，不把 Provider 字段当作 HTML', () => {
  const html = renderTaskTimeline({ items:[{
    title:'<img src=x onerror=alert(1)>', summary:'<script>alert(1)</script>',
    technical:{ provider:'<b>provider</b>', artifactRefs:[{ artifactId:'artifact-1', title:'<i>证据</i>' }] },
  }] });
  assert.doesNotMatch(html, /<script>|<img|<b>provider|<i>证据/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;b&gt;provider/);
});

test('游标续载复用同一只读接口并保留已有事件', async () => {
  const urls = [];
  const loader = createTaskTimelineLoader({ api:async (url) => {
    urls.push(url);
    return urls.length === 1
      ? { items:[{ eventId:'1', title:'开始' }], nextCursor:'page_2', filters:['quality'] }
      : { items:[{ eventId:'2', title:'完成' }], nextCursor:null, filters:['quality'] };
  } });
  await loader.load(taskId, { nextFilters:['quality', 'quality', 'unknown'] });
  const html = await loader.loadMore();

  assert.match(urls[0], new RegExp(`/api/tasks/${taskId}/timeline\\?`));
  assert.match(urls[0], /filter=quality/);
  assert.match(urls[1], /cursor=page_2/);
  assert.deepEqual(loader.snapshot().items.map((item) => item.eventId), ['1', '2']);
  assert.match(html, /开始/);
  assert.match(html, /完成/);
});
