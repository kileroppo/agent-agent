import { m5CaseProjectId, } from './paperclip-publisher-contract.ts';
const M5_GRAY_DAY_ALLOWED_STAGES: any = new Set([
    'topic',
    'parallel_join_gate',
    'script',
    'render',
]);
const M5_GRAY_DENIED_STATES: any = new Set([
    'blocked',
    'cancelled',
    'done',
    'failed',
    'terminated',
]);
export const paperclipM5CaseMethods: Record<string, any> = {
    async getPipelineCaseOutputs(caseId: any): Promise<any> {
        return this.request(`/api/cases/${encodeURIComponent(caseId)}/outputs`);
    },
    async getPipelineCase(caseId: any): Promise<any> {
        return this.request(`/api/cases/${encodeURIComponent(caseId)}`);
    },
    async getPipelineCaseEvents(caseId: any): Promise<any> {
        return this.request(`/api/cases/${encodeURIComponent(caseId)}/events?limit=100&order=desc`);
    },
    async patchPipelineCaseFields(caseId: any, { expectedVersion, fields, runId, }: any = {}): Promise<any> {
        return this.request(`/api/cases/${encodeURIComponent(caseId)}`, {
            method: 'PATCH',
            runId,
            body: {
                expectedVersion,
                fields,
            },
        });
    },
    async reopenM5StageIssue(issueId: any, { runId, comment }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH',
            runId,
            body: {
                status: 'todo',
                comment,
            },
        });
    },
    async blockM5StageIssue(issueId: any, { runId, comment }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH',
            runId,
            body: {
                status: 'blocked',
                comment,
            },
        });
    },
    async completeM5RecoveredStageIssue(issueId: any, { runId, comment }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH',
            runId,
            body: {
                status: 'done',
                comment,
            },
        });
    },
    async getRetrospectiveMetricOutputs(caseId: any): Promise<any> {
        const detail: any = await this.getPipelineCase(caseId);
        const item: any = detail?.case ?? detail;
        const pipelineId: any = item?.pipelineId || detail?.pipeline?.id;
        if (!pipelineId)
            throw new Error('M5 复盘 Case 缺少可信 Pipeline 绑定。');
        const rows: any = await this.request(`/api/pipelines/${encodeURIComponent(pipelineId)}/cases`);
        const cases: any = Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [];
        const outputs: any = await Promise.all(cases.map((entry: any): any => {
            const linkedCase: any = entry?.case ?? entry;
            if (!linkedCase?.id)
                return [];
            return this.getPipelineCaseOutputs(linkedCase.id)
                .then((value: any): any => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : []);
        }));
        return { items: outputs.flat() };
    },
    async getNextM5GrayTargetCase(caseId: any): Promise<any> {
        const detail: any = await this.getPipelineCase(caseId);
        const current: any = detail?.case ?? detail;
        const pipelineId: any = current?.pipelineId || detail?.pipeline?.id;
        const currentDate: any = String(current?.fields?.scheduledDate || '');
        if (!pipelineId || !/^\d{4}-\d{2}-\d{2}$/.test(currentDate))
            return null;
        const rows: any = await this.request(`/api/pipelines/${encodeURIComponent(pipelineId)}/cases`);
        const candidates: any = (Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [])
            .map((entry: any): any => {
            const item: any = entry?.case ?? entry;
            return {
                ...item,
                stageKey: item?.stageKey ?? entry?.stage?.key ?? item?.stage?.key ?? null,
            };
        })
            .filter((item: any): any => item?.id
            && item?.fields?.scheduledDate > currentDate
            && item?.fields?.platform === 'douyin'
            && item?.parentCaseId
            && !item?.fields?.workBranch
            && !item?.fields?.parallelJoin
            && item?.stageKey === 'machine_review')
            .sort((left: any, right: any): any => left.fields.scheduledDate.localeCompare(right.fields.scheduledDate)
            || String(left.id).localeCompare(String(right.id)));
        if (candidates.length === 0)
            return null;
        const selected: any = candidates[0];
        const dayDetail: any = await this.getPipelineCase(selected.parentCaseId);
        const day: any = dayDetail?.case ?? dayDetail;
        const dayStageKey: any = day?.stageKey ?? dayDetail?.stage?.key ?? day?.stage?.key ?? null;
        const scheduledDate: any = String(selected.fields.scheduledDate || '');
        const campaignId: any = String(selected.fields?.campaignId || '');
        const currentCampaignId: any = String(current?.fields?.campaignId || '');
        const dayCampaignId: any = String(day?.fields?.campaignId || '');
        const currentProjectId: any = m5CaseProjectId(detail, current);
        const dayProjectId: any = m5CaseProjectId(dayDetail, day);
        if (day?.id !== selected.parentCaseId
            || !day?.parentCaseId
            || selected.pipelineId !== pipelineId
            || day?.pipelineId !== pipelineId
            || String(day?.fields?.scheduledDate || '') !== scheduledDate
            || day?.fields?.platform
            || day?.fields?.workBranch
            || day?.fields?.parallelJoin
            || !campaignId
            || campaignId !== currentCampaignId
            || campaignId !== dayCampaignId
            || !currentProjectId
            || currentProjectId !== dayProjectId
            || !M5_GRAY_DAY_ALLOWED_STAGES.has(dayStageKey)
            || m5GrayCaseInactive(selected)
            || m5GrayCaseInactive(dayDetail)) {
            throw new Error('M5 灰度平台 Case 的父日期 Case 链、日期、项目、活动或可执行状态复核失败。');
        }
        return {
            caseId: selected.id,
            dayCaseId: day.id,
            scheduledDate,
            platform: 'douyin',
        };
    },
    async transitionPipelineCase(caseId: any, payload: any, { runId }: any = {}): Promise<any> {
        return this.request(`/api/cases/${encodeURIComponent(caseId)}/transition`, {
            method: 'POST',
            runId,
            body: payload,
        });
    },
    async assertCaseIssueLink(caseId: any, issueId: any): Promise<any> {
        const rows: any = await this.request(`/api/cases/${encodeURIComponent(caseId)}/issue-links`);
        const links: any = Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [];
        if (!links.some((item: any): any => (item.issue?.id || item.issueId) === issueId)) {
            throw new Error('M5 系统控制器任务与声明的 Pipeline Case 没有关联。');
        }
        return { caseId, issueId };
    },
    async verifyHermesAssignment({ issueId, runId, paperclipAgentId, agentArmyId }: any = {}): Promise<any> {
        const safeIssueId: any = requiredIdentifier(issueId, 'Paperclip 任务标识缺失。');
        const safeRunId: any = requiredIdentifier(runId, 'Paperclip 运行标识缺失。');
        const safePaperclipAgentId: any = requiredIdentifier(paperclipAgentId, 'Paperclip 员工标识缺失。');
        const safeAgentArmyId: any = String(agentArmyId || '').trim();
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(safeAgentArmyId))
            throw new Error('军团员工标识无效。');
        const [issue, paperclipAgent, runDocument] = await Promise.all([
            this.getPaperclipIssue(safeIssueId),
            this.getPaperclipAgent(safePaperclipAgentId),
            this.getPaperclipIssueRuns(safeIssueId)
        ]);
        if (!paperclipAgent || paperclipAgent.metadata?.agentArmyId !== safeAgentArmyId) {
            throw new Error('Paperclip 员工与 Hermes Profile 身份不一致。');
        }
        if (issue.assigneeAgentId !== paperclipAgent.id)
            throw new Error('该任务没有指派给当前员工。');
        const runs: any = Array.isArray(runDocument) ? runDocument : Array.isArray(runDocument?.runs) ? runDocument.runs : [];
        const rawRun: any = runs.find((item: any): any => (item?.id || item?.runId) === safeRunId && (!item.agentId || item.agentId === paperclipAgent.id));
        if (!rawRun)
            throw new Error('Paperclip 当前运行与任务指派不一致。');
        const run: Record<string, any> = { ...rawRun, id: rawRun.id || rawRun.runId };
        return { issue, run, paperclipAgent, agentArmyId: safeAgentArmyId };
    },
    async verifySystemAssignment({ issueId, runId, paperclipAgentId, systemRole, }: any = {}): Promise<any> {
        const safeIssueId: any = requiredIdentifier(issueId, 'Paperclip 任务标识缺失。');
        const safeRunId: any = requiredIdentifier(runId, 'Paperclip 运行标识缺失。');
        const safePaperclipAgentId: any = requiredIdentifier(paperclipAgentId, 'Paperclip 控制器标识缺失。');
        const safeSystemRole: any = String(systemRole || '').trim();
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(safeSystemRole))
            throw new Error('Paperclip 系统控制器角色无效。');
        const [issue, paperclipAgent, activeRun, heartbeatRun] = await Promise.all([
            this.getPaperclipIssue(safeIssueId),
            this.getPaperclipAgent(safePaperclipAgentId),
            this.getPaperclipIssueActiveRun(safeIssueId),
            this.getPaperclipHeartbeatRun(safeRunId),
        ]);
        if (!paperclipAgent || paperclipAgent.metadata?.agentArmySystemRole !== safeSystemRole) {
            throw new Error('Paperclip HTTP 系统控制器身份不一致。');
        }
        if (issue.assigneeAgentId !== paperclipAgent.id) {
            throw new Error('该任务没有指派给当前 HTTP 系统控制器。');
        }
        if (issue.status !== 'in_progress'
            || activeRun?.id !== safeRunId
            || activeRun?.status !== 'running'
            || activeRun?.agentId !== paperclipAgent.id) {
            throw new Error('Paperclip 当前活跃运行与 HTTP 系统控制器指派不一致。');
        }
        if (heartbeatRun?.id !== safeRunId
            || heartbeatRun?.status !== 'running'
            || heartbeatRun?.agentId !== paperclipAgent.id
            || !issue.companyId
            || heartbeatRun.companyId !== issue.companyId
            || paperclipAgent.companyId !== issue.companyId) {
            throw new Error('Paperclip 当前活跃运行身份无效。');
        }
        return { issue, run: heartbeatRun, paperclipAgent, systemRole: safeSystemRole };
    }
};
function m5GrayCaseInactive(value: any): any {
    const item: any = value?.case ?? value;
    const stage: any = value?.stage ?? item?.stage;
    const activeWork: any = value?.activeWork ?? item?.activeWork;
    const terminalKind: any = String(item?.terminalKind || value?.terminalKind || '').trim();
    const states: any = [
        item?.status,
        item?.stageKey,
        stage?.key,
        stage?.kind,
        activeWork?.status,
        item?.fields?.m5StageRecovery?.status,
    ].map((state: any): any => String(state || '').trim().toLowerCase());
    const stageRecoveries: any = Object.values(item?.fields?.m5ContentRecovery?.stageRecoveries || {});
    return (!item?.id
        || item?.blocked === true
        || item?.terminal === true
        || terminalKind.length > 0
        || states.some((state: any): any => M5_GRAY_DENIED_STATES.has(state))
        || stageRecoveries.some((entry: any): any => M5_GRAY_DENIED_STATES.has(String(entry?.status || '').trim().toLowerCase())));
}
function requiredIdentifier(value: any, message: any): any {
    const identifier: any = String(value || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(identifier))
        throw new Error(message);
    return identifier;
}
