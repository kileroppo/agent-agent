import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M5ProductionTemplateResolver,
  m5GrayProductionTemplateBinding,
} from '../src/m5-production-template-resolver.js';

const SAFE = {
  promptMutation:false,
  permissionExpansion:false,
  frequencyIncrease:false,
  paidPromotion:false,
};

test('缺少或未通过决定时使用内置默认模板', async () => {
  const resolver = resolverFor([]);
  const binding = await resolver.resolve('case-1');
  assert.equal(binding.source, 'built_in_default');
  assert.equal(binding.templateVersionId, 'm5-template-default-v1');
  assert.deepEqual(binding.controls, SAFE);
});

test('只消费灰度通过且血缘完整的productionDefault模板', async () => {
  const resolver = resolverFor([
    templateProduct(),
    decisionProduct({
      status:'validated',
      templateVersionId:'template-v2',
      previousTemplateVersionId:'m5-template-default-v1',
      activeTemplateVersionId:'template-v2',
      automaticRollback:false,
      productionDefault:true,
    }),
  ]);
  const binding = await resolver.resolve('case-1');
  assert.equal(binding.source, 'approved_learning_decision');
  assert.equal(binding.templateVersionId, 'template-v2');
  assert.equal(binding.decisionStatus, 'validated');
  assert.deepEqual(binding.contentGuidance, ['只调整前三秒开场。']);
});

test('审核后的灰度模板只绑定预约Case且不成为生产默认', async () => {
  const target = templateProduct();
  target.metadata.templateVersion.grayTargetCaseId = 'case-gray-1';
  target.metadata.templateVersion.grayTargetDayCaseId = 'day-gray-1';
  target.metadata.templateVersion.grayTargetScheduledDate = '2026-08-09';
  target.metadata.templateVersion.grayTargetPlatform = 'douyin';
  target.metadata.templateVersion.grayReleaseLimit = 1;
  target.metadata.templateVersion.applicationScope = 'full_content_variant';
  const resolver = resolverFor([target]);
  const gray = await resolver.resolve('case-gray-1');
  assert.equal(gray.source, 'approved_single_gray');
  assert.equal(gray.templateVersionId, 'template-v2');
  assert.equal(gray.grayTargetPlatform, 'douyin');
  assert.equal(gray.productionDefault, false);
  const byDay = await resolver.resolveGrayForDay('day-gray-1');
  assert.equal(byDay.bindingHash, gray.bindingHash);
  assert.equal(gray.bindingHash, m5GrayProductionTemplateBinding({
    templateVersion:target.metadata.templateVersion,
    templateWorkProductId:target.id,
  }).bindingHash);
  const changedCanonical = structuredClone(target.metadata.templateVersion);
  changedCanonical.suggestedChanges = ['结尾增加一个核验动作。'];
  assert.notEqual(gray.bindingHash, m5GrayProductionTemplateBinding({
    templateVersion:changedCanonical,
    templateWorkProductId:target.id,
  }).bindingHash);
  const other = await resolver.resolve('case-other');
  assert.equal(other.source, 'built_in_default');
});

test('新一轮审核灰度预约可以覆盖更早的生产决定', async () => {
  const target = templateProduct();
  target.metadata.templateVersion.grayTargetCaseId = 'case-gray-2';
  target.metadata.templateVersion.grayTargetDayCaseId = 'day-gray-2';
  target.metadata.templateVersion.grayTargetScheduledDate = '2026-08-10';
  target.metadata.templateVersion.grayTargetPlatform = 'douyin';
  target.metadata.templateVersion.grayReleaseLimit = 1;
  target.metadata.templateVersion.applicationScope = 'full_content_variant';
  target.metadata.templateVersion.approvedAt = '2026-08-13T00:00:00.000Z';
  const oldDecision = decisionProduct({
    status:'validated',
    templateVersionId:'template-v1',
    previousTemplateVersionId:'m5-template-default-v1',
    activeTemplateVersionId:'template-v1',
    automaticRollback:false,
    productionDefault:true,
  });
  oldDecision.metadata.decision.decidedAt = '2026-08-12T00:00:00.000Z';
  const binding = await resolverFor([target, oldDecision]).resolve('case-gray-2');
  assert.equal(binding.source, 'approved_single_gray');
  assert.equal(binding.templateVersionId, 'template-v2');
});

test('回退决定恢复上一模板且不会携带新模板指导', async () => {
  const resolver = resolverFor([
    decisionProduct({
      status:'rolled_back',
      templateVersionId:'template-v2',
      previousTemplateVersionId:'m5-template-default-v1',
      activeTemplateVersionId:'m5-template-default-v1',
      automaticRollback:true,
      productionDefault:false,
    }),
  ]);
  const binding = await resolver.resolve('case-1');
  assert.equal(binding.source, 'approved_learning_decision');
  assert.equal(binding.templateVersionId, 'm5-template-default-v1');
  assert.equal(binding.decisionStatus, 'rolled_back');
  assert.deepEqual(binding.contentGuidance, []);
});

test('最新决定包含扩权控制或冲突时阻断生产，不静默回退默认模板', async () => {
  const unsafe = decisionProduct({
    status:'validated',
    templateVersionId:'template-v2',
    previousTemplateVersionId:'m5-template-default-v1',
    activeTemplateVersionId:'template-v2',
    automaticRollback:false,
    productionDefault:true,
  });
  unsafe.metadata.decision.controls.permissionExpansion = true;
  await assert.rejects(
    () => resolverFor([templateProduct(), unsafe]).resolve('case-1'),
    (error) => error?.code === 'm5_production_template_blocked'
      && error?.reason === 'unsafe_controls',
  );
});

test('已批准和灰度模板拒绝空、重复或占位的 suggestedChanges', async () => {
  for (const suggestedChanges of [
    [],
    ['只调整前三秒开场。', '只调整前三秒开场。'],
    ['待补充一个示例开场。'],
  ]) {
    const gray = templateProduct();
    Object.assign(gray.metadata.templateVersion, {
      grayTargetCaseId:'case-gray-invalid',
      grayTargetDayCaseId:'day-gray-invalid',
      grayTargetScheduledDate:'2026-08-09',
      grayTargetPlatform:'douyin',
      grayReleaseLimit:1,
      applicationScope:'full_content_variant',
      suggestedChanges,
    });
    await assert.rejects(
      () => resolverFor([gray]).resolve('case-gray-invalid'),
      (error) => error?.code === 'm5_production_template_blocked'
        && error?.reason === 'gray_template_invalid',
    );

    const approved = templateProduct();
    approved.metadata.templateVersion.suggestedChanges = suggestedChanges;
    await assert.rejects(
      () => resolverFor([
        approved,
        decisionProduct({
          status:'validated',
          templateVersionId:'template-v2',
          previousTemplateVersionId:'m5-template-default-v1',
          activeTemplateVersionId:'template-v2',
          automaticRollback:false,
          productionDefault:true,
        }),
      ]).resolve('case-approved-invalid'),
      (error) => error?.code === 'm5_production_template_blocked'
        && error?.reason === 'template_lineage_invalid',
    );
  }
});

function resolverFor(items) {
  return new M5ProductionTemplateResolver({
    governance:{
      async getRetrospectiveMetricOutputs() {
        return { items:structuredClone(items) };
      },
    },
  });
}

function templateProduct() {
  return {
    id:'template-product',
    kind:'work_product',
    type:'document',
    provider:'agent-army.m5-learning',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/template-version/v1',
      kind:'TemplateVersion',
      templateVersion:{
        templateVersionId:'template-v2',
        previousTemplateVersionId:'m5-template-default-v1',
        state:'gray_ready',
        productionDefault:false,
        suggestedChanges:['只调整前三秒开场。'],
        approvedAt:'2026-08-11T00:00:00.000Z',
        controls:{ ...SAFE },
      },
    },
  };
}

function decisionProduct(decision) {
  return {
    id:'decision-product',
    kind:'work_product',
    type:'document',
    provider:'agent-army.m5-learning',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/template-decision/v1',
      kind:'TemplateDecision',
      decision:{
        ...decision,
        decidedAt:'2026-08-12T00:00:00.000Z',
        controls:{ ...SAFE },
      },
    },
  };
}
