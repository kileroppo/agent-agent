import assert from 'node:assert/strict';
import test from 'node:test';
import { PanoramicSystemHealthInspector } from '../src/panoramic-system-health.ts';

test('PanoramicSystemHealthInspector 探活全部健康服务并输出健康得分 100', async () => {
  const inspector = new PanoramicSystemHealthInspector();

  inspector.registerProber('xiaod_transcriber', async () => ({
    ok: true,
    latencyMs: 15,
    detail: '小D Whisper & ffmpeg 就绪',
  }));

  inspector.registerProber('local_ai', async () => ({
    ok: true,
    latencyMs: 8,
    detail: 'Local AI 18082 正常',
  }));

  const report = await inspector.inspectAll();
  assert.equal(report.overallStatus, 'healthy');
  assert.equal(report.healthScore, 100);
  assert.equal(report.healthyCount, 5);
  assert.equal(report.actionableRecommendations.length, 0);
});

test('PanoramicSystemHealthInspector 准确识别离线服务并输出自愈建议', async () => {
  const inspector = new PanoramicSystemHealthInspector();

  inspector.registerProber('publisher_gateway', async () => {
    throw new Error('ECONNREFUSED');
  });

  const report = await inspector.inspectAll();
  assert.equal(report.overallStatus, 'degraded');
  assert.ok(report.healthScore < 100);

  const pubComp = report.components.find((c) => c.id === 'publisher_gateway');
  assert.equal(pubComp.status, 'offline');
  assert.ok(report.actionableRecommendations.some((r) => r.includes('M5 多平台发布网关')));
});
