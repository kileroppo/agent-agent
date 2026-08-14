import { buildM5V2CloneDefinition } from './migration.ts';
import { buildBootstrapPlan, listM5RequiredAgentKeys } from './plan.ts';
import { containsDeclared, pipelineHeaderMatchesDeclaration, routineMatchesDeclaration, stageMatchesDeclaration, } from './reconcile.ts';
import { M5_EXISTING_V2_RECONCILE_CONFIRMATION, buildRollbackSnapshot, logicalTransitions, transitionSetsEqual, } from './reconcile-v2-journal.ts';
const SYSTEM_CONTROLLER_BINDINGS = {
    'm5-daily-controller': 'dailyControllerAgentId',
    'm5-metrics-controller': 'metricsControllerAgentId',
    'm5-publisher-controller': 'publisherControllerAgentId',
    'm5-retrospective-controller': 'retrospectiveControllerAgentId',
    'm5-learning-controller': 'learningControllerAgentId',
    'm5-parallel-controller': 'parallelControllerAgentId',
};
export async function inspectExistingM5V2Reconcile({ adapter, definition, pipelineId, projectId, now = () => new Date(), }: any = {}) {
    assertInputs({ adapter, definition, pipelineId, projectId });
    const targetDefinition = toV2Definition(definition);
    const blockers: any[] = [];
    const [pipelineDocument, projectDocument, routineDocument, caseDocument, agentDocument,] = await Promise.all([
        adapter.request('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}`),
        adapter.request('GET', `/api/projects/${encodeURIComponent(projectId)}`),
        adapter.request('GET', `/api/companies/${encodeURIComponent(adapter.companyId)}/routines`),
        adapter.request('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}/cases`),
        adapter.request('GET', `/api/companies/${encodeURIComponent(adapter.companyId)}/agents`),
    ]);
    const pipeline = unwrap(pipelineDocument, 'pipeline');
    const project = unwrap(projectDocument, 'project');
    const routines = rows(routineDocument).filter((item: any) => item.projectId === projectId);
    const agents = rows(agentDocument);
    const cases = rows(caseDocument);
    check(blockers, pipeline?.id === pipelineId
        && pipeline?.key === targetDefinition.key
        && pipeline?.projectId === projectId, 'target_identity_mismatch', '目标必须是传入 project 下的既有 m5 v2 Pipeline');
    check(blockers, project?.id === projectId
        && String(project?.description || '').includes(`[agent-army:m5:project:${targetDefinition.project.key}]`), 'project_identity_mismatch', 'Project 缺少目标 v2 marker 或 ID 不匹配');
    const goalIds = unique([
        ...(Array.isArray(project?.goalIds) ? project.goalIds : []),
        ...(project?.goalId ? [project.goalId] : []),
    ]);
    check(blockers, goalIds.length === 1, 'project_goal_ambiguous', `v2 Project 必须且只能绑定一个 Goal，当前为 ${goalIds.length} 个`);
    const goalId = goalIds[0] ?? null;
    const agentBindings = resolveExactAgentBindings({
        agents,
        definition: targetDefinition,
        blockers,
    });
    const governedRoutines = routines.filter((item: any) => item.status !== 'archived');
    const routineIndex = indexVersionedRoutines({
        routines: governedRoutines,
        namespace: targetDefinition.key,
        blockers,
    });
    const routineIds = Object.fromEntries([...routineIndex.entries()]
        .filter(([, matches]: any) => matches.length === 1)
        .map(([key, matches]: any) => [key, matches[0].id]));
    const plan = buildBootstrapPlan(targetDefinition, {
        ...agentBindings,
        resourceNamespace: targetDefinition.key,
        projectId,
        goalId,
        routineIds,
    });
    const desiredRoutines = [
        ...plan.resources.routines,
        plan.resources.scheduleRoutine,
    ];
    const desiredKeys = new Set(desiredRoutines.map((item: any) => item.key));
    const unexpectedKeys = [...routineIndex.keys()].filter((key: any) => !desiredKeys.has(key));
    check(blockers, unexpectedKeys.length === 0, 'unexpected_v2_routine', `v2 Project 存在未声明 Routine: ${unexpectedKeys.join(', ')}`);
    const routineDetails = new Map();
    for (const routine of governedRoutines) {
        const detail = await adapter.request('GET', `/api/routines/${encodeURIComponent(routine.id)}`);
        routineDetails.set(routine.id, unwrap(detail, 'routine'));
    }
    const desiredByKey = new Map(desiredRoutines.map((item: any) => [item.key, item]));
    const assetsDesired = desiredByKey.get('m5-assets');
    const visualDesired = desiredByKey.get('m5-visual-analysis');
    const assetsMatches = routineIndex.get('m5-assets') ?? [];
    const visualMatches = routineIndex.get('m5-visual-analysis') ?? [];
    check(blockers, assetsMatches.length === 1, 'assets_routine_not_unique', `m5-assets 必须唯一，当前为 ${assetsMatches.length} 条`);
    check(blockers, visualMatches.length <= 1, 'visual_routine_not_unique', `m5-visual-analysis 至多一条，当前为 ${visualMatches.length} 条`);
    const assets = assetsMatches[0]
        ? routineDetails.get(assetsMatches[0].id)
        : null;
    const visual = visualMatches[0]
        ? routineDetails.get(visualMatches[0].id)
        : null;
    const legacyAssetsPayload = assetsDesired
        ? buildLegacyAssetsPayload(assetsDesired.payload)
        : null;
    const assetsState = assets && assetsDesired
        ? routineMatchesDeclaration(assets, assetsDesired.payload)
            ? 'desired'
            : routineMatchesDeclaration(assets, legacyAssetsPayload)
                ? 'legacy'
                : 'unexpected'
        : 'missing';
    check(blockers, ['desired', 'legacy'].includes(assetsState) && assets?.env == null, 'assets_unexpected_drift', 'm5-assets 不是已知旧声明/目标声明或含未声明 env，拒绝覆盖');
    const visualState = visual && visualDesired
        ? routineMatchesDeclaration(visual, visualDesired.payload)
            ? 'desired'
            : 'unexpected'
        : 'missing';
    check(blockers, ['desired', 'missing'].includes(visualState) && (!visual || visual.env == null), 'visual_unexpected_drift', '既有 m5-visual-analysis 与目标声明不一致或含未声明 env');
    for (const desired of desiredRoutines) {
        if (['m5-assets', 'm5-visual-analysis'].includes(desired.key))
            continue;
        const matches = routineIndex.get(desired.key) ?? [];
        if (matches.length !== 1) {
            blockers.push({
                code: 'routine_identity_mismatch',
                detail: `${desired.key} 必须唯一，当前为 ${matches.length} 条`,
            });
            continue;
        }
        const detail = routineDetails.get(matches[0].id);
        check(blockers, routineMatchesDeclaration(detail, desired.payload), 'unrelated_routine_drift', `${desired.key} 与声明不一致；专用对账拒绝顺带修改`);
    }
    const pipelineHeaderMatches = pipelineHeaderMatchesDeclaration(pipeline, plan.resources.pipeline.payload);
    const stageDrift = plan.resources.pipeline.payload.stages
        .filter((desired: any) => {
        const actual = pipeline?.stages?.find((item: any) => item.key === desired.key);
        return !actual || !stageMatchesDeclaration(actual, desired);
    })
        .map((item: any) => item.key);
    const unexpectedStages = (pipeline?.stages ?? [])
        .filter((actual: any) => !plan.resources.pipeline.payload.stages.some((item: any) => item.key === actual.key))
        .map((item: any) => item.key);
    check(blockers, pipelineHeaderMatches && stageDrift.length === 0 && unexpectedStages.length === 0, 'pipeline_declaration_drift', `Pipeline header/stage 漂移: missing-or-drift=${stageDrift.join(',') || 'none'}; unexpected=${unexpectedStages.join(',') || 'none'}`);
    const liveTransitions = logicalTransitions(pipeline);
    const desiredTransitions = structuredClone(plan.resources.pipeline.transitions);
    const legacyTransitions = desiredTransitions.map((item: any) => item.fromStageKey === 'parallel_join_gate'
        && item.toStageKey === 'render'
        && item.label === '五分支汇聚完成'
        ? { ...item, label: '四分支汇聚完成' }
        : item);
    const transitionState = transitionSetsEqual(liveTransitions, desiredTransitions)
        ? 'desired'
        : transitionSetsEqual(liveTransitions, legacyTransitions)
            ? 'legacy'
            : 'unexpected';
    check(blockers, ['desired', 'legacy'].includes(transitionState), 'transition_unexpected_drift', 'Pipeline transitions 不是已知四分支旧声明或五分支目标声明');
    assertDraftCampaign({
        blockers,
        cases,
        projectId,
        deploymentKey: targetDefinition.key,
    });
    const daily = routineIndex.get('m5-daily-campaign')?.[0];
    const dailyDetail = daily ? routineDetails.get(daily.id) : null;
    const scheduleTriggers = (dailyDetail?.triggers ?? [])
        .filter((item: any) => item.kind === 'schedule');
    check(blockers, (dailyDetail?.triggers ?? []).length === 1
        && scheduleTriggers.length === 1
        && containsDeclared(scheduleTriggers[0], plan.resources.scheduleTrigger)
        && scheduleTriggers[0].enabled === false
        && scheduleTriggers[0].lastFiredAt == null, 'daily_trigger_not_pristine_off', 'v2 每日 Trigger 必须唯一、关闭且从未触发');
    if (assets?.id) {
        const runs = rows(await adapter.request('GET', `/api/routines/${encodeURIComponent(assets.id)}/runs?limit=1`));
        check(blockers, runs.length === 0, 'assets_has_runs', 'm5-assets 已有运行记录，拒绝自动改写声明');
    }
    if (visual?.id) {
        const runs = rows(await adapter.request('GET', `/api/routines/${encodeURIComponent(visual.id)}/runs?limit=1`));
        check(blockers, runs.length === 0, 'visual_has_runs', 'm5-visual-analysis 已有运行记录，拒绝对账');
    }
    const diff = {
        createRoutine: visualState === 'missing'
            ? [{
                    key: 'm5-visual-analysis',
                    marker: visualDesired?.marker,
                    payload: visualDesired?.payload,
                }]
            : [],
        updateRoutine: assetsState === 'legacy'
            ? [{
                    key: 'm5-assets',
                    id: assets.id,
                    fromRevisionId: assets.latestRevisionId ?? null,
                    payload: assetsDesired.payload,
                }]
            : [],
        updateTransitions: transitionState === 'legacy',
        transitionCount: desiredTransitions.length,
        unchangedRoutines: desiredRoutines.length
            - (visualState === 'missing' ? 1 : 0)
            - (assetsState === 'legacy' ? 1 : 0),
        unchangedStages: stageDrift.length === 0 && unexpectedStages.length === 0
            ? plan.resources.pipeline.payload.stages.length
            : 0,
    };
    const rollbackSnapshot = buildRollbackSnapshot({
        now,
        adapter,
        pipelineId,
        pipelineKey: targetDefinition.key,
        projectId,
        assets,
        assetsDesired,
        visual,
        visualDesired,
        liveTransitions,
        desiredTransitions,
    });
    return {
        schemaVersion: 'agent.army/m5-existing-v2-reconcile-audit/v1',
        mode: 'dry-run',
        target: {
            companyId: adapter.companyId,
            pipelineId,
            pipelineKey: targetDefinition.key,
            projectId,
            goalId,
        },
        states: {
            assets: assetsState,
            visualAnalysis: visualState,
            transitions: transitionState,
            campaignGrantStatus: campaignGrantStatus(cases),
            cronEnabled: scheduleTriggers[0]?.enabled ?? null,
        },
        checks: {
            routineCount: governedRoutines.length,
            expectedRoutineCount: desiredRoutines.length,
            stageCount: pipeline?.stages?.length ?? null,
            transitionCount: liveTransitions.length,
        },
        blockers,
        preconditionsPassed: blockers.length === 0,
        diff,
        desired: {
            assetsRoutine: assetsDesired,
            visualRoutine: visualDesired,
            transitions: desiredTransitions,
        },
        rollbackSnapshot,
        writesToLivePaperclip: false,
        confirmation: M5_EXISTING_V2_RECONCILE_CONFIRMATION,
    };
}
function assertInputs({ adapter, definition, pipelineId, projectId }: any) {
    if (!adapter?.request || !adapter?.companyId) {
        throw new Error('现有 M5 v2 对账需要已限定公司的 Paperclip adapter');
    }
    if (!definition?.key || !pipelineId || !projectId) {
        throw new Error('现有 M5 v2 对账缺少 definition、pipelineId 或 projectId');
    }
}
function toV2Definition(definition: any) {
    if (definition.key.endsWith('-v2') && definition.project?.key?.endsWith('-v2')) {
        return structuredClone(definition);
    }
    return buildM5V2CloneDefinition(definition);
}
function resolveExactAgentBindings({ agents, definition, blockers }: any) {
    const agentIds: Record<string, string> = {};
    for (const owner of listM5RequiredAgentKeys(definition)) {
        const matches = agents.filter((agent: any) => agent.status !== 'terminated' && agent.metadata?.agentArmyId === owner);
        check(blockers, matches.length === 1, 'business_agent_binding_mismatch', `岗位 ${owner} 必须唯一，当前为 ${matches.length} 个`);
        if (matches.length === 1)
            agentIds[owner] = matches[0].id;
    }
    const result: Record<string, any> = { agentIds };
    for (const [role, bindingKey] of Object.entries(SYSTEM_CONTROLLER_BINDINGS)) {
        const matches = agents.filter((agent: any) => agent.status !== 'terminated' && agent.metadata?.agentArmySystemRole === role);
        check(blockers, matches.length === 1, 'system_controller_binding_mismatch', `系统控制器 ${role} 必须唯一，当前为 ${matches.length} 个`);
        if (matches.length === 1)
            result[bindingKey] = matches[0].id;
    }
    return result;
}
function indexVersionedRoutines({ routines, namespace, blockers }: any) {
    const prefix = `[agent-army:m5:deployment:${namespace}:routine:`;
    const index = new Map();
    for (const routine of routines) {
        const descriptions = String(routine.description || '');
        const matches = [...descriptions.matchAll(new RegExp(`\\[agent-army:m5:deployment:${escapeRegExp(namespace)}:routine:([^\\]]+)\\]`, 'g'))];
        check(blockers, matches.length === 1, 'routine_namespace_marker_mismatch', `Routine ${routine.id} 必须且只能含一个 ${prefix}... marker`);
        if (matches.length !== 1)
            continue;
        const key = matches[0][1];
        const rowsForKey = index.get(key) ?? [];
        rowsForKey.push(routine);
        index.set(key, rowsForKey);
    }
    return index;
}
export function assertDraftCampaign({ blockers, cases, projectId, deploymentKey }: any) {
    const normalized = cases.map((item: any) => ({
        case: item?.case ?? item,
        stage: item?.stage ?? null,
        activeWork: item?.activeWork ?? item?.case?.activeWork ?? null,
        descendantActiveWorkCount: Number(item?.descendantActiveWorkCount ?? item?.case?.descendantActiveWorkCount ?? 0),
    }));
    const item = normalized[0];
    const record = item?.case;
    check(blockers, normalized.length === 1
        && !record?.parentCaseId
        && (item?.stage?.key ?? record?.stageKey) === 'draft'
        && record?.fields?.campaignGrant?.status === 'draft'
        && record?.fields?.deploymentKey === deploymentKey
        && record?.fields?.projectId === projectId
        && Number(record?.childCount ?? 0) === 0
        && !item?.activeWork
        && item?.descendantActiveWorkCount === 0
        && !record?.leaseToken
        && !record?.terminalKind, 'campaign_not_pristine_draft', 'v2 必须只有一个未批准、未运行、无子项的 draft Campaign Case');
}
function campaignGrantStatus(cases: any) {
    if (cases.length !== 1)
        return null;
    const record = cases[0]?.case ?? cases[0];
    return record?.fields?.campaignGrant?.status ?? null;
}
function buildLegacyAssetsPayload(payload: any) {
    return {
        ...structuredClone(payload),
        title: 'M5 / 并行画面分析',
        description: String(payload.description)
            .replace('只处理素材和关键帧并写回 AssetPackage，不输出画面分析结论。', '完成素材和视觉证据处理并写回 AssetPackage。'),
    };
}
export function check(blockers: any, passed: any, code: any, detail: any) {
    if (!passed)
        blockers.push({ code, detail });
}
export function rows(payload: any) {
    if (Array.isArray(payload))
        return payload;
    if (Array.isArray(payload?.items))
        return payload.items;
    return [];
}
export function unwrap(payload: any, key: any) {
    return payload?.[key] ?? payload;
}
function unique(values: any) {
    return [...new Set(values.filter(Boolean))];
}
function escapeRegExp(value: any) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
