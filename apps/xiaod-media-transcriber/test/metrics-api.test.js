import test from 'node:test';
import assert from 'node:assert/strict';

import { collectMetricsRequest, MetricsRequestError } from '../src/metrics-api.js';

test('metrics request resolves the approved connection and returns a sanitized bundle', async () => {
  const calls = [];
  const expected = { schemaVersion:'agent.army/boom-metrics-bundle/v1', status:'collected' };
  const contentRuntime = {
    resolveConnectionBindingForSource:async (source, connectionId) => {
      calls.push({ type:'resolve', source, connectionId });
      return { connectionId:'connection-1', provider:'xhs' };
    },
    contentCenter:{
      collectMetrics:async (input) => {
        calls.push({ type:'collect', ...input });
        return { ok:true, metricsBundle:expected };
      }
    }
  };

  const result = await collectMetricsRequest({
    contentRuntime,
    input:{ url:'https://www.xiaohongshu.com/explore/target', historyLimit:20 }
  });

  assert.equal(result, expected);
  assert.equal(calls[1].connectionId, 'connection-1');
  assert.equal(calls[1].requestingAgentId, 'xiaod');
  assert.equal(calls[1].historyLimit, 20);
});

test('metrics request keeps missing login state as an actionable response', async () => {
  const contentRuntime = {
    resolveConnectionBindingForSource:async () => null,
    contentCenter:{ collectMetrics:async () => ({ ok:false, code:'connection_required', safeMessage:'请先连接账号。', recommendedAction:'reauthorize' }) }
  };
  await assert.rejects(
    () => collectMetricsRequest({ contentRuntime, input:{ url:'https://www.douyin.com/video/target' } }),
    (error) => error instanceof MetricsRequestError
      && error.status === 409
      && error.code === 'connection_required'
  );
});

test('metrics request rejects non-public URLs before selecting an account', async () => {
  let called = false;
  const contentRuntime = {
    resolveConnectionBindingForSource:async () => { called = true; },
    contentCenter:{ collectMetrics:async () => ({ ok:true }) }
  };
  await assert.rejects(
    () => collectMetricsRequest({ contentRuntime, input:{ url:'file:///tmp/video.mp4' } }),
    (error) => error instanceof MetricsRequestError && error.status === 422
  );
  assert.equal(called, false);
});
