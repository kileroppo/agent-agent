import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildScoreComparison,
  buildV2Score,
  bundleToRecord,
  evaluateGrade,
  pythonRound,
  scoreWork,
} from '../src/boom-monitor/index.js';

function bundle(historyCount = 6) {
  return {
    schemaVersion:'agent.army/boom-metrics-bundle/v1',
    status:historyCount >= 5 ? 'collected' : 'insufficient_history',
    platform:'xiaohongshu',
    sourceUrl:'https://example.com/target',
    observedAt:'2026-08-05T12:00:00Z',
    creator:{ id:'creator-1', name:'作者', followerCount:1_000 },
    currentWork:{
      id:'target', title:'当前作品', sourceUrl:'https://example.com/target',
      likes:500, favorites:100, plays:null,
    },
    historyWorks:Array.from({ length:historyCount }, (_, index) => ({
      id:`history-${index}`, likes:100, favorites:20, plays:null,
    })),
    historyOrder:'creator_feed_desc',
    sampleCount:historyCount,
  };
}

test('legacy scorer keeps R on core interactions and M on likes', () => {
  assert.equal(evaluateGrade(6, 0.1, 100_000), 'T2');
  assert.deepEqual(scoreWork(400, 1_000, [100, 100, 100, 100, 100], { mMetric:100 }), {
    r_value:4,
    m_value:0.1,
    grade:'N0',
    tier:'low',
    baseline_metric:100,
    sample_count:5,
  });
  assert.equal(scoreWork(10_000, 1_000, [10, 10, 10, 10], { mMetric:10_000 }).grade, 'N0');
});

test('rounding matches Python half-even at exact, negative, and ordinary boundaries', () => {
  assert.equal(pythonRound(1 / 32, 4), 0.0312);
  assert.equal(pythonRound(-1.2345, 3), -1.234);
  assert.equal(pythonRound(-1.2355, 3), -1.236);
  assert.equal(pythonRound(1.23456, 4), 1.2346);
  assert.equal(pythonRound(2.675, 2), 2.67);
  const score = scoreWork(1, 32, [32, 32, 32, 32, 32], { mMetric:1 });
  assert.equal(score.r_value, 0.0312);
  assert.equal(score.m_value, 0.0312);
  assert.equal(score.grade, 'N0');
  assert.equal(evaluateGrade(3, 0.04, 1_000_000), 'T2');
  assert.equal(evaluateGrade(3, 0.03999, 1_000_000), 'T1');
});

test('v2 is official, promotes quality evidence, and keeps legacy rollback score', () => {
  const value = bundle(12);
  value.creator.followerCount = 2_147;
  Object.assign(value.currentWork, { likes:93, favorites:34, shares:24, comments:7 });
  value.historyWorks = Array.from({ length:12 }, (_, index) => ({
    id:`history-${index}`, likes:8, favorites:2, shares:0, comments:0,
  }));
  const result = buildScoreComparison(value);
  assert.equal(result.official_score.version, 'v2');
  assert.equal(result.official_score.grade, 'T1');
  assert.equal(result.official_score.absolute_interactions, 127);
  assert.equal(result.official_score.signals.quality.passed, true);
  assert.equal(result.official_score.controls_dispatch, true);
  assert.equal(result.legacy_score.version, 'legacy-v1');
  assert.equal(result.legacy_score.grade, 'N0');
  assert.equal(result.legacy_score.controls_dispatch, false);
});

test('v2 keeps first valid baseline and quality medians frozen', () => {
  const value = bundle();
  value.historyWorks = Array.from({ length:6 }, (_, index) => ({
    id:`history-${index}`, likes:1_000, favorites:200,
  }));
  const frozen = {
    version:'v2', baseline_version:'url-history-v2', baseline_metric:100,
    sample_count:6, follower_snapshot:2_000, baseline_at:'2026-08-01T00:00:00Z',
    signals:{ quality:{ history_medians:{ favorite_rate:0.02, share_rate:null, comment_rate:null } } },
  };
  const result = buildV2Score(value, frozen);
  assert.equal(result.baseline_metric, 100);
  assert.equal(result.follower_snapshot, 2_000);
  assert.equal(result.baseline_at, '2026-08-01T00:00:00Z');
  assert.equal(result.signals.quality.favorite_rate_vs_history, 10);
});

test('collected record preserves unknown plays and does not invent publish time', () => {
  const record = bundleToRecord(bundle());
  assert.equal(record.publish_at, '');
  assert.equal(record.plays, null);
  assert.equal(record.metadata.history_order, 'creator_feed_desc');
});
