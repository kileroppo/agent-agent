#!/usr/bin/env node
// data-lifecycle-gc.mjs — 全系统数据闭环与分级留存安全治理 CLI
//
// 用法：
//   node scripts/data-lifecycle-gc.mjs                # dry-run，只报告待清理项与存储占用，不删
//   node scripts/data-lifecycle-gc.mjs --apply        # 执行全系统安全清理
//   node scripts/data-lifecycle-gc.mjs --status       # 仅查看各数据存储水位状态

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const STATUS_ONLY = process.argv.includes('--status');

const fmtBytes = (bytes) => {
  if (!bytes || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < u.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(2)} ${u[i]}`;
};

async function main() {
  console.log('\n Agent 军团 · 全系统数据闭环治理');
  console.log(`模式: ${STATUS_ONLY ? 'STATUS（只读状态）' : APPLY ? 'APPLY（安全清理）' : 'DRY-RUN（只读预览）'}`);
  console.log('─'.repeat(72));

  // 1. A君任务库 (SQLiteTaskStore)
  const taskDbPath = path.join(root, 'apps/ajun-runtime/data/runtime.sqlite');
  if (fs.existsSync(taskDbPath)) {
    try {
      const { SQLiteTaskStore } = await import(path.join(root, 'apps/ajun-runtime/src/sqlite-task-store.ts'));
      const taskStore = new SQLiteTaskStore(taskDbPath);
      const counts = await taskStore.inspectCounts();
      console.log(`\n📦 [A君任务库] (${taskDbPath})`);
      console.log(`   总任务数: ${counts.tasks || 0} | 审批: ${counts.approvals || 0} | 对话上下文: ${counts.conversationContexts || 0} | 测试实例: ${counts.testInstances || 0}`);

      if (!STATUS_ONLY) {
        const pruneRes = await taskStore.pruneExpiredRecords({ dryRun: !APPLY });
        if (APPLY) {
          console.log(`   ✓ 清理完成: 删减例行任务 ${pruneRes.deleted.routineTasks}，历史终态 ${pruneRes.deleted.terminalTasks}，闲置上下文 ${pruneRes.deleted.conversationContexts}，测试实例 ${pruneRes.deleted.testInstances}`);
        } else {
          console.log(`   ℹ 待清理项: 例行任务 ${pruneRes.expiring.routineTasks}，历史终态 ${pruneRes.expiring.terminalTasks}，闲置上下文 ${pruneRes.expiring.conversationContexts}，测试实例 ${pruneRes.expiring.testInstances} (共 ${pruneRes.totalExpiring} 项)`);
        }
      }
      taskStore.close();
    } catch (err) {
      console.log(`   ✗ 任务库检查失败: ${err.message}`);
    }
  } else {
    console.log(`\n📦 [A君任务库] 未找到数据文件: ${taskDbPath}`);
  }

  // 2. 运行事件库 (TaskRunEventStore)
  const eventDbPath = path.join(root, 'apps/ajun-runtime/data/task-run-events.sqlite');
  if (fs.existsSync(eventDbPath)) {
    try {
      const { TaskRunEventStore } = await import(path.join(root, 'apps/ajun-runtime/src/task-run-event-store.ts'));
      const eventStore = new TaskRunEventStore(eventDbPath);
      const counts = eventStore.inspectCounts();
      console.log(`\n📊 [运行事件库] (${eventDbPath})`);
      console.log(`   总事件数: ${counts.totalEvents} (transient: ${counts.byClass?.transient || 0}, detail: ${counts.byClass?.detail || 0}, audit: ${counts.byClass?.audit || 0}, permanent: ${counts.byClass?.permanent || 0})`);
      console.log(`   脱敏事故摘要数: ${counts.incidentSummaries}`);

      if (!STATUS_ONLY) {
        if (APPLY) {
          const res = eventStore.cleanupExpiredDetails();
          console.log(`   ✓ 清理完成: 删除过期事件 ${res.deletedEvents} 条，沉淀事故摘要 ${res.incidentSummariesCreated} 条`);
        } else {
          const res = eventStore.previewExpiredEvents();
          console.log(`   ℹ 待清理事件: ${res.expiringEvents} 条 (transient: ${res.expiringByClass?.transient || 0}, detail: ${res.expiringByClass?.detail || 0})`);
        }
      }
      eventStore.close();
    } catch (err) {
      console.log(`   ✗ 运行事件库检查失败: ${err.message}`);
    }
  } else {
    console.log(`\n📊 [运行事件库] 未找到数据文件: ${eventDbPath}`);
  }

  // 3. 小D媒体作业库 (JobStore)
  const xiaodDataDir = path.join(root, 'apps/xiaod-media-transcriber/data');
  const xiaodJobsFile = path.join(xiaodDataDir, 'jobs.json');
  if (fs.existsSync(xiaodJobsFile)) {
    try {
      const { JobStore } = await import(path.join(root, 'apps/xiaod-media-transcriber/src/store.ts'));
      const jobStore = new JobStore(xiaodDataDir);
      await jobStore.init();
      const allJobs = jobStore.list();
      console.log(`\n🎬 [小D媒体作业库] (${xiaodJobsFile})`);
      console.log(`   当前作业总数: ${allJobs.length}`);

      if (!STATUS_ONLY) {
        const res = await jobStore.pruneExpiredJobs({ dryRun: !APPLY });
        if (APPLY) {
          console.log(`   ✓ 清理完成: 清除超期作业 ${res.prunedJobsCount} 个，释放磁盘空间 ${fmtBytes(res.reclaimedBytes)}`);
        } else {
          console.log(`   ℹ 待清理超期作业: ${res.prunedJobsCount} 个，预计释放空间: ${fmtBytes(res.reclaimedBytes)}`);
        }
      }
    } catch (err) {
      console.log(`   ✗ 小D作业库检查失败: ${err.message}`);
    }
  } else {
    console.log(`\n🎬 [小D媒体作业库] 未找到数据文件: ${xiaodJobsFile}`);
  }

  console.log('\n' + '─'.repeat(72));
  if (!APPLY && !STATUS_ONLY) {
    console.log('若确认清理以上过期数据，请执行: npm run data:gc -- --apply\n');
  } else {
    console.log('数据闭环治理检查完成。\n');
  }
}

main().catch((err) => {
  console.error('执行数据闭环 CLI 发生未捕获异常:', err);
  process.exit(1);
});
