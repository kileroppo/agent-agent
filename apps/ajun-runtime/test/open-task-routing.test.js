import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideIntelResearchOpenTask,
  inspectOpenTaskManifestCapabilities,
  recoverIntelResearchOpenTaskState,
  routeOpenTaskForExecutor
} from '../src/open-task-routing.ts';

test('开放复杂任务无状态路由到岗位专用执行器且不生成第二控制面标记', () => {
  const agent = {
    agentId:'intel-researcher',
    acceptedTaskTypes:['research.intel-report', 'research.open-investigation'],
    openTaskPolicy:{ domain:'research', qualityGateMode:'manifest-required' }
  };
  const task = {
    taskId:'task-open-research',
    taskType:'research.open-investigation',
    input:{
      title:'比较三种智能体治理方式',
      goalSpec:{
        objective:'形成有证据的比较报告',
        deliverables:['比较报告'],
        acceptanceCriteria:['至少比较三种方式']
      },
      context:{ requesterChannel:'local' }
    }
  };

  const routed = routeOpenTaskForExecutor(task, agent);

  assert.equal(routed.taskType, 'research.intel-report');
  assert.equal(routed.input.context.openTaskType, 'research.open-investigation');
  assert.equal(routed.input.context.delegatedTaskType, 'research.intel-report');
  assert.equal(routed.input.context.controlPlane, 'paperclip');
  assert.equal(routed.input.context.autonomousWorkPlan, undefined);
  assert.deepEqual(routed.input.goalSpec, task.input.goalSpec);
  assert.equal(task.taskType, 'research.open-investigation');
});

test('开放任务能力请求只读取岗位Manifest白名单且不创建任务级授权', () => {
  const agent = {
    agentId:'intel-researcher',
    acceptedTaskTypes:['research.open-investigation'],
    openTaskPolicy:{ domain:'research' },
    toolAllowlist:['content.public.fetch'],
    runtimeCapabilities:{
      mcpTools:['task_get'],
      skills:['public-research']
    }
  };
  const task = {
    taskType:'research.open-investigation',
    input:{
      goalSpec:{
        capabilityRequests:[
          { capabilityId:'content.public.fetch', purpose:'读取公开资料' }
        ],
        requestedPermissions:['private.account.login']
      }
    }
  };

  const inspection = inspectOpenTaskManifestCapabilities(task, agent);

  assert.deepEqual(inspection.requested, ['content.public.fetch', 'private.account.login']);
  assert.deepEqual(inspection.missing, ['private.account.login']);
  assert.equal(inspection.allowed, false);
  assert.equal(Object.hasOwn(inspection, 'grants'), false);
});

test('开放任务无状态路由仍拒绝GoalSpec中的凭据', () => {
  const agent = {
    agentId:'intel-researcher',
    acceptedTaskTypes:['research.open-investigation'],
    openTaskPolicy:{ domain:'research' }
  };
  const task = {
    taskType:'research.open-investigation',
    input:{ goalSpec:{ token:'should-not-enter-task-truth' } }
  };

  assert.throws(
    () => inspectOpenTaskManifestCapabilities(task, agent),
    /敏感字段/
  );
});

test('小R根据真实PDF Observation在Manifest白名单内切换读取Adapter', () => {
  const agent = {
    agentId:'intel-researcher',
    acceptedTaskTypes:['research.open-investigation'],
    openTaskPolicy:{ domain:'research' },
    toolAllowlist:[
      'content.public.fetch',
      'content.public.pdf.read',
      'github.public.read',
    ],
  };
  const task = {
    taskId:'task-open-pdf',
    taskType:'research.open-investigation',
    input:{
      goalSpec:{
        objective:'形成有证据的公开资料报告',
        acceptanceCriteria:['至少两个可核验来源'],
      },
    },
  };

  const decision = decideIntelResearchOpenTask({
    task,
    agent,
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-pdf-1',
      issueId:'issue-research-1',
      runId:'run-research-1',
      toolId:'content.public.fetch',
      outcome:'failed',
      classification:'pdf_detected',
      error:{ code:'content_type_pdf', retryable:false },
      recordedAt:'2026-07-31T01:00:00.000Z',
    },
    progress:{ stepsUsed:1, safeRetriesUsed:0, replansUsed:0 },
    budget:{ remainingUnits:9, estimatedNextStepUnits:1 },
    now:() => new Date('2026-07-31T01:00:01.000Z'),
  });

  assert.equal(decision.action, 'switch_adapter');
  assert.equal(decision.selectedToolId, 'content.public.pdf.read');
  assert.equal(decision.source.runId, 'run-research-1');
  assert.equal(decision.source.issueId, 'issue-research-1');
  assert.equal(decision.budget.remainingUnitsAfterDecision, 8);
  assert.match(decision.successCondition, /公开 PDF/);
  assert.match(decision.decisionId, /^sha256:[0-9a-f]{64}$/);
  assert.match(decision.source.observationHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(decision.paperclipWrites[0].kind, 'append_run_observation');
  assert.equal(decision.paperclipWrites[0].runId, 'run-research-1');
  assert.equal(decision.paperclipWrites[0].issueId, 'issue-research-1');
  assert.equal(decision.paperclipWrites.some((item) => item.kind === 'create_work_product'), false);
});

test('小R根据动态网页Observation切换到公开动态读取而不获得通用浏览器', () => {
  const decision = decideIntelResearchOpenTask({
    task:{
      taskId:'task-open-dynamic',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'核验公开动态页面' } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch', 'content.public.dynamic.read'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-dynamic-1',
      issueId:'issue-research-2',
      runId:'run-research-2',
      toolId:'content.public.fetch',
      outcome:'failed',
      classification:'dynamic_page_required',
      error:{ code:'client_render_required', retryable:false },
      recordedAt:'2026-07-31T01:10:00.000Z',
    },
    progress:{ stepsUsed:2, safeRetriesUsed:0, replansUsed:0 },
    budget:{ remainingUnits:7, estimatedNextStepUnits:1 },
  });

  assert.equal(decision.action, 'switch_adapter');
  assert.equal(decision.selectedToolId, 'content.public.dynamic.read');
  assert.equal(decision.budget.stepsRemaining, 5);
  assert.equal(JSON.stringify(decision).includes('browser'), false);
  assert.equal(JSON.stringify(decision).includes('terminal'), false);
});

test('小R根据GitHub来源Observation切换到公开仓库读取Adapter', () => {
  const decision = decideIntelResearchOpenTask({
    task:{
      taskId:'task-open-github',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'核验开源实现' } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch', 'github.public.read'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-github-1',
      issueId:'issue-research-3',
      runId:'run-research-3',
      toolId:'content.public.fetch',
      outcome:'failed',
      classification:'github_repository_detected',
      error:{ code:'github_repository_url', retryable:false },
      recordedAt:'2026-07-31T01:20:00.000Z',
    },
    progress:{ stepsUsed:2, safeRetriesUsed:0, replansUsed:0 },
    budget:{ remainingUnits:6, estimatedNextStepUnits:1 },
  });

  assert.equal(decision.action, 'switch_adapter');
  assert.equal(decision.selectedToolId, 'github.public.read');
  assert.match(decision.successCondition, /公开 GitHub/);
});

test('小R仅在错误可重试且预算充足时安全重试原公开读取工具', () => {
  const decision = decideIntelResearchOpenTask({
    task:{
      taskId:'task-open-retry',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'核验公开来源' } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-retry-1',
      issueId:'issue-research-4',
      runId:'run-research-4',
      toolId:'content.public.fetch',
      outcome:'failed',
      classification:'transport_unavailable',
      error:{ code:'upstream_timeout', retryable:true },
      recordedAt:'2026-07-31T01:30:00.000Z',
    },
    progress:{ stepsUsed:2, safeRetriesUsed:1, replansUsed:0 },
    budget:{ remainingUnits:3, estimatedNextStepUnits:1 },
  });

  assert.equal(decision.action, 'safe_retry');
  assert.equal(decision.selectedToolId, 'content.public.fetch');
  assert.equal(decision.budget.safeRetriesRemaining, 0);
  assert.equal(decision.progress.safeRetriesUsed, 1);
});

test('安全重试耗尽后请求Paperclip重规划且不伪造工具调用', () => {
  const decision = decideIntelResearchOpenTask({
    task:{
      taskId:'task-open-replan',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'核验公开来源' } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-replan-1',
      issueId:'issue-research-5',
      runId:'run-research-5',
      toolId:'content.public.fetch',
      outcome:'failed',
      classification:'transport_unavailable',
      error:{ code:'upstream_timeout', retryable:true },
      recordedAt:'2026-07-31T01:40:00.000Z',
    },
    progress:{ stepsUsed:4, safeRetriesUsed:2, replansUsed:1 },
    budget:{ remainingUnits:4, estimatedNextStepUnits:1 },
  });

  assert.equal(decision.action, 'request_replan');
  assert.equal(decision.selectedToolId, null);
  assert.equal(decision.replanAllowed, true);
  assert.equal(decision.budget.replansRemaining, 1);
  assert.equal(
    decision.paperclipWrites.some((item) => item.kind === 'request_plan_revision'),
    true,
  );
});

test('三次重规划耗尽后只写阻塞Observation而不创建第四次PlanRevision', () => {
  const decision = decideIntelResearchOpenTask({
    task:{
      taskId:'task-open-replan-exhausted',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'核验公开来源' } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-replan-exhausted',
      issueId:'issue-research-6',
      runId:'run-research-6',
      toolId:'content.public.fetch',
      outcome:'failed',
      classification:'transport_unavailable',
      error:{ code:'upstream_timeout', retryable:true },
      recordedAt:'2026-07-31T01:50:00.000Z',
    },
    progress:{ stepsUsed:7, safeRetriesUsed:2, replansUsed:3 },
    budget:{ remainingUnits:4, estimatedNextStepUnits:1 },
  });

  assert.equal(decision.action, 'request_replan');
  assert.equal(decision.replanAllowed, false);
  assert.equal(decision.executionStatus, 'blocked');
  assert.equal(decision.budget.replansRemaining, 0);
  assert.equal(
    decision.paperclipWrites.some((item) => item.kind === 'request_plan_revision'),
    false,
  );
  assert.equal(
    decision.paperclipWrites.some((item) => item.kind === 'block_issue'),
    true,
  );
});

test('来源成功但验收未满足时只按Observation建议继续一个白名单步骤', () => {
  const decision = decideIntelResearchOpenTask({
    task:{
      taskId:'task-open-continue',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'比较公开方案', acceptanceCriteria:['至少两个来源'] } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch', 'content.public.search'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-continue-1',
      issueId:'issue-research-7',
      runId:'run-research-7',
      toolId:'content.public.fetch',
      outcome:'succeeded',
      classification:'source_verified',
      result:{
        acceptanceSatisfied:false,
        evidenceSourceCount:1,
        nextToolId:'content.public.search',
      },
      recordedAt:'2026-07-31T02:00:00.000Z',
    },
    progress:{ stepsUsed:3, safeRetriesUsed:0, replansUsed:0 },
    budget:{ remainingUnits:5, estimatedNextStepUnits:1 },
  });

  assert.equal(decision.action, 'continue');
  assert.equal(decision.selectedToolId, 'content.public.search');
  assert.equal(decision.budget.stepsRemaining, 4);
  assert.equal(decision.paperclipWrites.length, 1);
});

test('只有验收满足且健康产物属于当前Run时才完成并写Work Product', () => {
  const decision = decideIntelResearchOpenTask({
    task:{
      taskId:'task-open-complete',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'比较公开方案', acceptanceCriteria:['至少两个来源'] } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-complete-1',
      issueId:'issue-research-8',
      runId:'run-research-8',
      toolId:'controlled.intel-research-report',
      outcome:'succeeded',
      classification:'goal_satisfied',
      provenance:'trusted_report_executor',
      result:{
        acceptanceSatisfied:true,
        evidenceSourceCount:2,
        workProduct:{
          type:'ResearchReport',
          schemaVersion:'agent.army/intel-research-report/v1',
          runId:'run-research-8',
          artifactRef:'artifact://task-open-complete/report',
          sourceObservationIds:[
            'observation-source-1',
            'observation-source-2',
          ],
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            claimEvidenceBound:true,
          },
        },
      },
      recordedAt:'2026-07-31T02:10:00.000Z',
    },
    progress:{ stepsUsed:4, safeRetriesUsed:0, replansUsed:0 },
    budget:{ remainingUnits:4, estimatedNextStepUnits:1 },
  });

  assert.equal(decision.action, 'complete');
  assert.equal(decision.selectedToolId, null);
  assert.equal(decision.executionStatus, 'complete');
  const workProductWrite = decision.paperclipWrites.find(
    (item) => item.kind === 'create_work_product',
  );
  assert.equal(workProductWrite.runId, 'run-research-8');
  assert.equal(workProductWrite.issueId, 'issue-research-8');
  assert.equal(workProductWrite.artifactRef, 'artifact://task-open-complete/report');
});

test('任务自报健康报告、跨Run报告或不足两个真实Observation都不能完成', () => {
  const base = {
    task:{
      taskId:'task-open-fake-complete',
      taskType:'research.open-investigation',
      input:{
        goalSpec:{ objective:'比较公开方案' },
        report:{ status:'healthy', acceptanceSatisfied:true },
      },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch'],
    },
    progress:{ stepsUsed:3, safeRetriesUsed:0, replansUsed:0 },
    budget:{ remainingUnits:4, estimatedNextStepUnits:1 },
  };
  const observation = {
    schemaVersion:'agent.army/tool-observation/v1',
    observationId:'observation-fake-complete',
    issueId:'issue-research-fake',
    runId:'run-research-current',
    toolId:'controlled.intel-research-report',
    outcome:'succeeded',
    classification:'goal_satisfied',
    provenance:'trusted_report_executor',
    result:{
      acceptanceSatisfied:true,
      evidenceSourceCount:2,
      workProduct:{
        type:'ResearchReport',
        schemaVersion:'agent.army/intel-research-report/v1',
        runId:'run-research-other',
        artifactRef:'artifact://task-open-fake-complete/report',
        sourceObservationIds:['observation-source-1', 'observation-source-2'],
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          claimEvidenceBound:true,
        },
      },
    },
    recordedAt:'2026-07-31T02:11:00.000Z',
  };

  assert.throws(
    () => decideIntelResearchOpenTask({ ...base, observation }),
    /尚无受控研究路线/,
  );
  assert.throws(
    () => decideIntelResearchOpenTask({
      ...base,
      observation:{
        ...observation,
        result:{
          ...observation.result,
          workProduct:{
            ...observation.result.workProduct,
            runId:'run-research-current',
            sourceObservationIds:['observation-source-1'],
          },
        },
      },
    }),
    /尚无受控研究路线/,
  );
});

test('恢复时只接收内嵌Issue和Run都与当前assignment一致的来源Observation', () => {
  const issueId = 'issue-research-scope-current';
  const runId = 'run-research-scope-current';
  const currentObservation = scopedSourceObservation({
    observationId:'observation-current-source',
    issueId,
    runId,
    sourceUrl:'https://example.com/current',
    hashCharacter:'a',
  });
  const wrongRunObservation = scopedSourceObservation({
    observationId:'observation-wrong-run',
    issueId,
    runId:'run-research-scope-other',
    sourceUrl:'https://example.org/wrong-run',
    hashCharacter:'b',
  });
  const wrongIssueObservation = scopedSourceObservation({
    observationId:'observation-wrong-issue',
    issueId:'issue-research-scope-other',
    runId,
    sourceUrl:'https://example.net/wrong-issue',
    hashCharacter:'c',
  });
  const workProducts = [
    scopedOpenResearchStep({
      issueId,
      runId,
      observation:wrongRunObservation,
      nextObservation:currentObservation,
      stepsUsed:1,
      decisionId:'decision-scope-1',
    }),
    scopedOpenResearchStep({
      issueId,
      runId,
      observation:wrongIssueObservation,
      nextObservation:currentObservation,
      stepsUsed:2,
      decisionId:'decision-scope-2',
    }),
  ];

  const recovered = recoverIntelResearchOpenTaskState({
    workProducts,
    issueId,
    runId,
  });

  assert.deepEqual(
    recovered.sourceObservations.map((item) => item.observationId),
    ['observation-current-source'],
  );
  assert.equal(recovered.completedReport, null);
});

test('步骤或预算不足时拒绝执行Observation建议的下一工具', () => {
  const decision = decideIntelResearchOpenTask({
    task:{
      taskId:'task-open-limit',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'核验公开PDF' } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch', 'content.public.pdf.read'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-limit-1',
      issueId:'issue-research-9',
      runId:'run-research-9',
      toolId:'content.public.fetch',
      outcome:'failed',
      classification:'pdf_detected',
      error:{ code:'content_type_pdf', retryable:false },
      recordedAt:'2026-07-31T02:20:00.000Z',
    },
    progress:{ stepsUsed:8, safeRetriesUsed:0, replansUsed:0 },
    budget:{ remainingUnits:0, estimatedNextStepUnits:1 },
  });

  assert.equal(decision.action, 'request_replan');
  assert.equal(decision.selectedToolId, null);
  assert.equal(decision.limitReason, 'step_limit_exhausted');
  assert.equal(decision.budget.stepsRemaining, 0);
  assert.equal(decision.budget.remainingUnitsAfterDecision, 0);
});

test('即使Manifest误含通用浏览器或终端也不能被开放研究决策选中', () => {
  const common = {
    task:{
      taskId:'task-open-forbidden-tool',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'继续公开研究' } },
    },
    progress:{ stepsUsed:1, safeRetriesUsed:0, replansUsed:0 },
    budget:{ remainingUnits:5, estimatedNextStepUnits:1 },
  };
  for (const nextToolId of ['browser.open', 'terminal.exec']) {
    assert.throws(
      () => decideIntelResearchOpenTask({
        ...common,
        agent:{
          agentId:'intel-researcher',
          acceptedTaskTypes:['research.open-investigation'],
          openTaskPolicy:{ domain:'research' },
          toolAllowlist:[nextToolId],
        },
        observation:{
          schemaVersion:'agent.army/tool-observation/v1',
          observationId:`observation-${nextToolId}`,
          issueId:'issue-research-10',
          runId:'run-research-10',
          toolId:'content.public.fetch',
          outcome:'succeeded',
          classification:'source_verified',
          result:{ acceptanceSatisfied:false, nextToolId },
          recordedAt:'2026-07-31T02:30:00.000Z',
        },
      }),
      /未授权/,
    );
  }
});

test('开放研究缺少或使用无效预算时失败关闭而不是按零成本继续', () => {
  const common = {
    task:{
      taskId:'task-open-no-budget',
      taskType:'research.open-investigation',
      input:{ goalSpec:{ objective:'继续公开研究' } },
    },
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.open-investigation'],
      openTaskPolicy:{ domain:'research' },
      toolAllowlist:['content.public.fetch', 'content.public.pdf.read'],
    },
    observation:{
      schemaVersion:'agent.army/tool-observation/v1',
      observationId:'observation-no-budget',
      issueId:'issue-research-11',
      runId:'run-research-11',
      toolId:'content.public.fetch',
      outcome:'failed',
      classification:'pdf_detected',
      error:{ code:'content_type_pdf', retryable:false },
      recordedAt:'2026-07-31T02:40:00.000Z',
    },
    progress:{ stepsUsed:1, safeRetriesUsed:0, replansUsed:0 },
  };

  assert.throws(() => decideIntelResearchOpenTask(common), /预算/);
  assert.throws(
    () => decideIntelResearchOpenTask({
      ...common,
      budget:{ remainingUnits:2.5, estimatedNextStepUnits:1 },
    }),
    /预算/,
  );
});

function scopedSourceObservation({
  observationId,
  issueId,
  runId,
  sourceUrl,
  hashCharacter,
}) {
  const sourceId = `source-${observationId}`;
  return {
    schemaVersion:'agent.army/tool-observation/v1',
    observationId,
    issueId,
    runId,
    toolId:'content.public.fetch',
    outcome:'succeeded',
    classification:'source_verified',
    provenance:'trusted_role_tool_adapter',
    result:{
      sourceEvidence:{
        sourceId,
        url:sourceUrl,
        fetchedAt:'2026-07-31T02:50:00.000Z',
        contentHash:`sha256:${hashCharacter.repeat(64)}`,
        evidenceFragment:{
          fragmentId:`${sourceId}-fragment`,
          text:'受控适配器来源证明。',
        },
      },
    },
    recordedAt:'2026-07-31T02:50:00.000Z',
  };
}

function scopedOpenResearchStep({
  issueId,
  runId,
  observation,
  nextObservation,
  stepsUsed,
  decisionId,
}) {
  return {
    id:`work-product-${decisionId}`,
    type:'OpenResearchStep',
    schemaVersion:'agent.army/open-research-step/v1',
    metadata:{
      issueId,
      runId,
      observation,
      nextObservation,
      decision:{ decisionId },
      progress:{ stepsUsed, safeRetriesUsed:0, replansUsed:0 },
      budget:{ remainingUnits:4, estimatedNextStepUnits:1 },
      recordedAt:'2026-07-31T02:50:00.000Z',
    },
  };
}
