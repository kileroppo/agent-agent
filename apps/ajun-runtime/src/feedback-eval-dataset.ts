import fs from 'node:fs';
import path from 'node:path';

export type EvalCase = {
  caseId: string;
  taskId: string;
  taskType: string;
  inputPrompt: string;
  producedArtifactSummary?: string;
  userFeedbackSentiment: string;
  userFeedbackNote?: string;
  tags: string[];
  createdAt: string;
};

export type BenchmarkExecutor = (caseItem: EvalCase) => Promise<{ output: string; [key: string]: unknown }>;
export type ScoreEvaluator = (actualOutput: string, caseItem: EvalCase) => Promise<{ passed: boolean; score: number; reason?: string }>;

export type FeedbackEvalDatasetOptions = {
  store?: any;
  datasetFilePath?: string;
  maxCases?: number;
  maxAgeDays?: number;
  now?: () => number;
};

export class FeedbackEvalDatasetService {
  private store: any;
  private datasetFilePath?: string;
  private maxCases: number;
  private maxAgeDays: number;
  private now: () => number;
  private cases = new Map<string, EvalCase>();

  constructor(options: FeedbackEvalDatasetOptions = {}) {
    this.store = options.store;
    this.datasetFilePath = options.datasetFilePath;
    this.maxCases = options.maxCases ?? 200;
    this.maxAgeDays = options.maxAgeDays ?? 90;
    this.now = options.now ?? (() => Date.now());

    if (this.datasetFilePath && fs.existsSync(this.datasetFilePath)) {
      try {
        const raw = fs.readFileSync(this.datasetFilePath, 'utf8');
        const list: EvalCase[] = JSON.parse(raw);
        for (const item of list) {
          if (item?.caseId) this.cases.set(item.caseId, item);
        }
      } catch {}
    }
  }

  sanitize(text?: string): string {
    if (!text) return '';
    return String(text)
      .replace(/(?:Bearer\s+[a-zA-Z0-9._-]+)/gi, 'Bearer ***')
      .replace(/(?:sk-[a-zA-Z0-9_-]{10,})/gi, 'sk-***')
      .replace(/(?:1[3-9]\d{9})/g, '138****0000')
      .replace(/(?:password|passwd|secret)=[^&\s]+/gi, '$1=***')
      .slice(0, 4000);
  }

  recordFromTask(task: any): EvalCase | null {
    if (!task) return null;
    const sentiment = task.feedback?.sentiment;
    const humanAcceptance = task.evaluation?.humanAcceptance?.status;
    if (sentiment !== 'needs_improvement' && humanAcceptance !== 'revision_required') return null;

    const taskId = String(task.taskId || 'unknown');
    const caseId = `eval-${taskId}`;
    if (this.cases.has(caseId)) return this.cases.get(caseId)!;

    const taskType = task.taskType || task.type || 'generic';
    const inputPrompt = this.sanitize(task.input?.title || task.input?.prompt || task.title || '');
    const artifactSummary = this.sanitize(task.output?.summary || task.summary || task.result?.summary || '');
    const feedbackNote = this.sanitize(task.feedback?.note || task.evaluation?.humanAcceptance?.note || '');

    const evalCase: EvalCase = {
      caseId, taskId, taskType, inputPrompt,
      producedArtifactSummary: artifactSummary || undefined,
      userFeedbackSentiment: sentiment || humanAcceptance || 'needs_improvement',
      userFeedbackNote: feedbackNote || undefined,
      tags: [taskType, 'user_negative_feedback'],
      createdAt: new Date(this.now()).toISOString(),
    };

    this.cases.set(caseId, evalCase);
    this.persist();
    return evalCase;
  }

  listCases({ taskType, limit }: { taskType?: string; limit?: number } = {}): EvalCase[] {
    let result = [...this.cases.values()];
    if (taskType) result = result.filter((c) => c.taskType === taskType);
    if (limit && limit > 0) result = result.slice(0, limit);
    return result;
  }

  async runOfflineBenchmark({
    cases = this.listCases(), executor, scoreEvaluator,
  }: {
    cases?: EvalCase[];
    executor: BenchmarkExecutor;
    scoreEvaluator: ScoreEvaluator;
  }): Promise<{
    totalCount: number; passCount: number; failCount: number; averageScore: number;
    results: Array<{ caseId: string; passed: boolean; score: number; reason?: string }>;
  }> {
    const results: Array<{ caseId: string; passed: boolean; score: number; reason?: string }> = [];
    let totalScore = 0;
    let passCount = 0;

    for (const caseItem of cases) {
      try {
        const execRes = await executor(caseItem);
        const evalRes = await scoreEvaluator(execRes.output, caseItem);
        results.push({ caseId: caseItem.caseId, passed: evalRes.passed, score: evalRes.score, reason: evalRes.reason });
        totalScore += evalRes.score;
        if (evalRes.passed) passCount += 1;
      } catch (err: any) {
        results.push({ caseId: caseItem.caseId, passed: false, score: 0, reason: err?.message || 'execution_error' });
      }
    }

    const totalCount = cases.length;
    const averageScore = totalCount > 0 ? Number((totalScore / totalCount).toFixed(2)) : 0;
    return { totalCount, passCount, failCount: totalCount - passCount, averageScore, results };
  }

  async reconcile(): Promise<{ status: string; totalCases: number; newCasesRecorded: number }> {
    if (!this.store || typeof this.store.list !== 'function') {
      return { status: 'reconciled', totalCases: this.cases.size, newCasesRecorded: 0 };
    }
    const allTasks = await this.store.list();
    let newCasesRecorded = 0;
    for (const task of allTasks) {
      const prevSize = this.cases.size;
      this.recordFromTask(task);
      if (this.cases.size > prevSize) newCasesRecorded += 1;
    }
    return { status: 'reconciled', totalCases: this.cases.size, newCasesRecorded };
  }

  prune({
    maxCases = this.maxCases, maxAgeDays = this.maxAgeDays, now = this.now(),
  }: { maxCases?: number; maxAgeDays?: number; now?: number } = {}): {
    beforeCount: number; afterCount: number; prunedCount: number;
  } {
    const beforeCount = this.cases.size;
    const cutoff = new Date(now - Math.max(1, maxAgeDays) * 86400000).toISOString();
    let list = [...this.cases.values()].filter((c) => (c.createdAt || '') >= cutoff);
    if (list.length > maxCases) {
      list = list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, maxCases);
    }
    this.cases = new Map(list.map((c) => [c.caseId, c]));
    const afterCount = this.cases.size;
    if (beforeCount !== afterCount) this.persist();
    return { beforeCount, afterCount, prunedCount: beforeCount - afterCount };
  }

  private persist() {
    if (!this.datasetFilePath) return;
    try {
      const dir = path.dirname(this.datasetFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.datasetFilePath, JSON.stringify([...this.cases.values()], null, 2), 'utf8');
    } catch {}
  }
}
