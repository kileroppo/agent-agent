import fs from 'node:fs';
import path from 'node:path';

export type ArtifactStorageGcOptions = {
  workspaceDirs?: string[];
  store?: any;
  mediaRetentionMs?: number; // 终态成功任务大媒体保留时间 (默认 7 天)
  scratchRetentionMs?: number; // 失败/取消任务临时目录保留时间 (默认 24 小时)
  orphanRetentionMs?: number; // 孤儿临时文件保留时间 (默认 6 小时)
  now?: () => number;
};

const DEFAULT_MEDIA_RETENTION_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_SCRATCH_RETENTION_MS = 24 * 3600 * 1000;
const DEFAULT_ORPHAN_RETENTION_MS = 6 * 3600 * 1000;

const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.flac', '.m4a']);

export class ArtifactStorageGcReconciler {
  private workspaceDirs: string[];
  private store: any;
  private mediaRetentionMs: number;
  private scratchRetentionMs: number;
  private orphanRetentionMs: number;
  private now: () => number;

  constructor(options: ArtifactStorageGcOptions = {}) {
    this.workspaceDirs = (options.workspaceDirs || [])
      .map((dir) => path.resolve(dir))
      .filter((dir) => Boolean(dir));
    this.store = options.store;
    this.mediaRetentionMs = options.mediaRetentionMs ?? DEFAULT_MEDIA_RETENTION_MS;
    this.scratchRetentionMs = options.scratchRetentionMs ?? DEFAULT_SCRATCH_RETENTION_MS;
    this.orphanRetentionMs = options.orphanRetentionMs ?? DEFAULT_ORPHAN_RETENTION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  isSafePath(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    return this.workspaceDirs.some((allowedRoot) => {
      const rel = path.relative(allowedRoot, resolved);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  async runGc({ dryRun = false, now = this.now() }: { dryRun?: boolean; now?: number } = {}): Promise<{
    cleanedFilesCount: number;
    cleanedBytes: number;
    cleanedEntries: string[];
  }> {
    let cleanedFilesCount = 0;
    let cleanedBytes = 0;
    const cleanedEntries: string[] = [];

    const allTasks = this.store && typeof this.store.list === 'function' ? await this.store.list() : [];
    const activeTaskIds = new Set(
      allTasks
        .filter((t: any) => ['running', 'planning', 'acquiring', 'analyzing', 'waiting_approval', 'needs_input'].includes(t.status))
        .map((t: any) => String(t.taskId))
    );

    const terminalTasksMap = new Map<string, any>();
    for (const t of allTasks) {
      if (['succeeded', 'failed', 'cancelled'].includes(t.status)) {
        terminalTasksMap.set(String(t.taskId), t);
      }
    }

    for (const rootDir of this.workspaceDirs) {
      if (!fs.existsSync(rootDir)) continue;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (!this.isSafePath(fullPath)) continue;

        try {
          const stats = fs.statSync(fullPath);
          const ageMs = now - stats.mtimeMs;

          // 场景 1: 按 taskId 组织的子目录
          const taskIdMatch = entry.name.match(/^(?:task-)?[a-zA-Z0-9_-]+/);
          const matchedTaskId = taskIdMatch ? taskIdMatch[0] : null;

          if (matchedTaskId && activeTaskIds.has(matchedTaskId)) {
            // 活跃任务目录豁免
            continue;
          }

          if (matchedTaskId && terminalTasksMap.has(matchedTaskId)) {
            const task = terminalTasksMap.get(matchedTaskId);
            const isSucceeded = task.status === 'succeeded';

            if (isSucceeded && entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (MEDIA_EXTENSIONS.has(ext) && ageMs > this.mediaRetentionMs) {
                cleanedBytes += stats.size;
                cleanedFilesCount += 1;
                cleanedEntries.push(fullPath);
                if (!dryRun) fs.unlinkSync(fullPath);
              }
            } else if (!isSucceeded && ageMs > this.scratchRetentionMs) {
              // 失败/取消任务的临时目录或产物
              cleanedBytes += stats.size;
              cleanedFilesCount += 1;
              cleanedEntries.push(fullPath);
              if (!dryRun) {
                if (entry.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
                else fs.unlinkSync(fullPath);
              }
            }
            continue;
          }

          // 场景 2: 孤儿临时文件（前缀为 tmp-, temp-, 或无匹配任务的旧文件）
          if (ageMs > this.orphanRetentionMs) {
            cleanedBytes += stats.size;
            cleanedFilesCount += 1;
            cleanedEntries.push(fullPath);
            if (!dryRun) {
              if (entry.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
              else fs.unlinkSync(fullPath);
            }
          }
        } catch {
          // 忽略单个文件处理异常
        }
      }
    }

    return {
      cleanedFilesCount,
      cleanedBytes,
      cleanedEntries,
    };
  }

  async reconcile(): Promise<{ status: string; cleanedFilesCount: number; cleanedBytes: number }> {
    const res = await this.runGc();
    return {
      status: 'reconciled',
      cleanedFilesCount: res.cleanedFilesCount,
      cleanedBytes: res.cleanedBytes,
    };
  }
}
