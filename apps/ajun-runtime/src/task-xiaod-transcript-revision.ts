import { ValidationError } from './task-service-execution-support.ts';
import { xiaodArtifactsFor } from './xiaod-reconciler.ts';
export const taskXiaodTranscriptRevisionMethods: Record<string, any> = {
    async getTranscriptRevision(taskId: any): Promise<any> {
        const task: any = await xiaodTranscriptTask(this, taskId);
        const executor: any = this.executors.xiaod;
        if (typeof executor?.getTranscriptRevision !== 'function') {
            throw new ValidationError('小D字幕读取能力当前不可用。');
        }
        return executor.getTranscriptRevision(task);
    },
    async reviseTranscript(taskId: any, input: any = {}): Promise<any> {
        const key: any = String(taskId || '').trim();
        const prior: any = this.xiaodTranscriptRevisionRuns.get(key) || Promise.resolve();
        const run: any = prior.catch((): any => undefined).then((): any => this.reviseTranscriptOnce(key, input));
        this.xiaodTranscriptRevisionRuns.set(key, run);
        try {
            return await run;
        }
        finally {
            if (this.xiaodTranscriptRevisionRuns.get(key) === run)
                this.xiaodTranscriptRevisionRuns.delete(key);
        }
    },
    async reviseTranscriptOnce(taskId: any, input: any = {}): Promise<any> {
        const task: any = await xiaodTranscriptTask(this, taskId);
        const executor: any = this.executors.xiaod;
        if (typeof executor?.reviseTranscript !== 'function') {
            throw new ValidationError('小D字幕补正能力当前不可用。');
        }
        const expectedVersion: any = Number(input.expectedVersion);
        const correctedTranscript: any = String(input.correctedTranscript || '');
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
            throw new ValidationError('请基于当前字幕版本提交补正。');
        if (!correctedTranscript.trim())
            throw new ValidationError('补正后的字幕不能为空。');
        const result: any = await executor.reviseTranscript(task, {
            expectedVersion,
            correctedTranscript,
            correctionSummary: String(input.correctionSummary || '').trim().slice(0, 500),
            editorRef: String(input.editorRef || 'local-owner').trim().slice(0, 120) || 'local-owner',
        });
        const projected: any = xiaodArtifactsFor(task, result.job, executor.baseUrl);
        const revisionTypes: any = new Set([
            'xiaod_media_delivery',
            'confirmed_transcript',
            'automatic_transcript_attestation',
            'human_review_attestation',
        ]);
        const revisionArtifacts: any = projected.filter((artifact: any): any => revisionTypes.has(artifact.type));
        if (!revisionArtifacts.some((artifact: any): any => artifact.type === 'confirmed_transcript')) {
            throw new ValidationError('小D已保存补正，但没有返回可同步的确认稿证据。');
        }
        const currentTask: any = await xiaodTranscriptTask(this, task.taskId);
        const larkRevisionStatus: any = String(result.job.output?.larkRevisionStatus || 'not_delivered');
        const updated: any = await this.store.updateTask(task.taskId, {
            execution: {
                ...(currentTask.execution || {}),
                transcriptRevision: {
                    version: Number(result.revision?.version) || expectedVersion + 1,
                    larkRevisionStatus,
                    syncedAt: new Date().toISOString(),
                },
            },
            artifactRefs: [
                ...(currentTask.artifactRefs || []).filter((artifact: any): any => !revisionTypes.has(artifact.type)),
                ...revisionArtifacts,
            ],
        });
        return { task: updated, revision: result.revision, duplicate: result.duplicate === true };
    },
};
async function xiaodTranscriptTask(service: any, taskId: any): Promise<any> {
    const normalizedTaskId: any = String(taskId || '').trim();
    const task: any = (await service.store.list()).find((item: any): any => item.taskId === normalizedTaskId);
    if (!task)
        throw new ValidationError('找不到要补正字幕的任务。');
    if (task.execution?.executor !== 'xiaod' || !task.execution?.xiaodJobId) {
        throw new ValidationError('这条任务没有可补正的小D字幕。');
    }
    return task;
}
