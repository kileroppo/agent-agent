import crypto from 'node:crypto';
import { M5_SCHEMA_IDS } from '@agent-army/m5-contracts';

const DEFAULT_TEMPLATE_VERSION_ID = 'm5-template-default-v1';
const SAFE_CONTROLS = Object.freeze({
  promptMutation:false,
  permissionExpansion:false,
  frequencyIncrease:false,
  paidPromotion:false,
});
const PLACEHOLDER_GUIDANCE_RE = /(?:\b(?:todo|tbd|placeholder|example)\b|待补充|待完善|待定|占位|示例|稍后补|以后补|这里(?:填写|补充)|未完成|x{3,})/i;
type DynamicRecord = Record<string, any>;
type TemplateControls = Readonly<{
  promptMutation?: unknown;
  permissionExpansion?: unknown;
  frequencyIncrease?: unknown;
  paidPromotion?: unknown;
}>;

export function defaultM5ProductionTemplateBinding(reason = 'default') {
  return freezeM5ProductionTemplateBinding({
    schemaVersion:M5_SCHEMA_IDS.PRODUCTION_TEMPLATE_BINDING,
    templateVersionId:DEFAULT_TEMPLATE_VERSION_ID,
    source:'built_in_default',
    decisionStatus:'default',
    decisionWorkProductId:null,
    productionDefault:true,
    contentGuidance:[],
    controls:SAFE_CONTROLS,
    fallbackReason:String(reason || 'default').slice(0, 80),
  });
}

export class M5ProductionTemplateResolutionError extends Error {
  readonly code = 'm5_production_template_blocked';
  readonly reason: string;

  constructor(reason: string) {
    super(`生产模板决定存在冲突或不安全状态：${reason}`);
    this.name = 'M5ProductionTemplateResolutionError';
    this.reason = reason;
  }
}

export function m5ProductionTemplateBindingHash(value: DynamicRecord): string {
  const binding = value && typeof value === 'object' ? value : {};
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion:String(binding.schemaVersion || ''),
    templateVersionId:String(binding.templateVersionId || ''),
    source:String(binding.source || ''),
    decisionStatus:String(binding.decisionStatus || ''),
    decisionWorkProductId:binding.decisionWorkProductId || null,
    templateWorkProductId:binding.templateWorkProductId || null,
    productionDefault:binding.productionDefault === true,
    grayRelease:binding.grayRelease === true,
    grayTargetCaseId:binding.grayTargetCaseId || null,
    grayTargetDayCaseId:binding.grayTargetDayCaseId || null,
    grayTargetScheduledDate:binding.grayTargetScheduledDate || null,
    grayTargetPlatform:binding.grayTargetPlatform || null,
    applicationScope:binding.applicationScope || null,
    contentGuidance:normalizeM5TemplateGuidance(binding.contentGuidance),
    controls:{
      promptMutation:binding.controls?.promptMutation,
      permissionExpansion:binding.controls?.permissionExpansion,
      frequencyIncrease:binding.controls?.frequencyIncrease,
      paidPromotion:binding.controls?.paidPromotion,
    },
  })).digest('hex')}`;
}

export function validM5ProductionTemplateBinding(value: DynamicRecord | null | undefined): boolean {
  const guidanceRequired = value?.source === 'approved_single_gray'
    || (value?.source === 'approved_learning_decision' && value?.decisionStatus === 'validated');
  return value != null
    && /^sha256:[0-9a-f]{64}$/i.test(String(value?.bindingHash || ''))
    && value.bindingHash === m5ProductionTemplateBindingHash(value)
    && JSON.stringify(value?.contentGuidance || [])
      === JSON.stringify(normalizeM5TemplateGuidance(value?.contentGuidance))
    && validM5TemplateGuidance(value?.contentGuidance, { allowEmpty:!guidanceRequired })
    && hasSafeM5TemplateControls(value?.controls);
}

export function validM5TemplateGuidance(
  value: unknown,
  { allowEmpty = false }: Readonly<{ allowEmpty?: boolean }> = {},
): boolean {
  if (!Array.isArray(value) || value.length > 4) return false;
  const normalized = normalizeM5TemplateGuidance(value);
  if (normalized.length !== value.length) return false;
  if (!allowEmpty && normalized.length === 0) return false;
  const keys = new Set();
  for (const guidance of normalized) {
    const key = guidanceKey(guidance);
    if (
      guidance.length < 4
      || PLACEHOLDER_GUIDANCE_RE.test(guidance)
      || !key
      || keys.has(key)
    ) return false;
    keys.add(key);
  }
  return true;
}

export function m5GrayProductionTemplateBinding({
  templateVersion,
  templateWorkProductId,
}: Readonly<{ templateVersion?: DynamicRecord; templateWorkProductId?: unknown }> = {}) {
  const template = templateVersion && typeof templateVersion === 'object'
    ? templateVersion
    : {};
  return freezeM5ProductionTemplateBinding({
    schemaVersion:M5_SCHEMA_IDS.PRODUCTION_TEMPLATE_BINDING,
    templateVersionId:String(template.templateVersionId || ''),
    source:'approved_single_gray',
    decisionStatus:'gray_ready',
    decisionWorkProductId:null,
    templateWorkProductId:String(templateWorkProductId || ''),
    productionDefault:false,
    grayRelease:true,
    grayTargetCaseId:String(template.grayTargetCaseId || ''),
    grayTargetDayCaseId:String(template.grayTargetDayCaseId || ''),
    grayTargetScheduledDate:String(template.grayTargetScheduledDate || ''),
    grayTargetPlatform:String(template.grayTargetPlatform || ''),
    applicationScope:String(template.applicationScope || ''),
    contentGuidance:normalizeM5TemplateGuidance(template.suggestedChanges),
    controls:{
      promptMutation:template.controls?.promptMutation,
      permissionExpansion:template.controls?.permissionExpansion,
      frequencyIncrease:template.controls?.frequencyIncrease,
      paidPromotion:template.controls?.paidPromotion,
    },
  });
}

export function freezeM5ProductionTemplateBinding(value: DynamicRecord) {
  const contentGuidance = Object.freeze(normalizeM5TemplateGuidance(value.contentGuidance));
  const binding = { ...value, contentGuidance };
  return Object.freeze({
    ...binding,
    bindingHash:m5ProductionTemplateBindingHash(binding),
  });
}

export function m5ProductionTemplateResolutionBlocked(reason: string) {
  return new M5ProductionTemplateResolutionError(reason);
}

export function hasSafeM5TemplateControls(value: TemplateControls | null | undefined): boolean {
  return value?.promptMutation === false
    && value?.permissionExpansion === false
    && value?.frequencyIncrease === false
    && value?.paidPromotion === false;
}

export function normalizeM5TemplateGuidance(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 240))
    .slice(0, 4);
}

export const M5_SAFE_TEMPLATE_CONTROLS = SAFE_CONTROLS;

function guidanceKey(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}
