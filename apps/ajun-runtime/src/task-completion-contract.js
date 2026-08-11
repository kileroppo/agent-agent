import { resolveAnalysisIntent } from './analysis-intent.ts';

const SPECIALIZED_COMPLETION_TYPES = new Set([
  'operations.health-review',
  'report.public-material',
  'research.github-search',
  'research.intel-report',
  'office.briefing-package',
  'office.presentation-package',
  'office.knowledge-summary',
  'content.video-benchmark-analysis',
  'content.platform-draft',
  'content.video-script-package',
  'content.performance-review',
  'media.transcribe-and-refine',
]);

export function validateTaskCompletion(task, artifactRefs = task?.artifactRefs || []) {
  const artifacts = Array.isArray(artifactRefs) ? artifactRefs : [];
  const taskType = String(task?.taskType || '').trim();
  let valid = false;
  let expectedArtifactTypes = [];

  switch (taskType) {
    case 'operations.health-review': {
      expectedArtifactTypes = ['health_report'];
      const report = readableArtifact(artifacts, 'health_report')?.data;
      valid = Boolean(report?.overall && Array.isArray(report.components) && report.components.length);
      break;
    }
    case 'report.public-material': {
      expectedArtifactTypes = ['public_web_report'];
      valid = Boolean(readableArtifact(artifacts, 'public_web_report')?.data?.summary);
      break;
    }
    case 'research.github-search': {
      expectedArtifactTypes = ['research_github_report', 'github_code_read'];
      const report = readableArtifact(artifacts, 'research_github_report')?.data;
      const read = readableArtifact(artifacts, 'github_code_read')?.data;
      valid = Boolean(report?.results?.length || read?.summary);
      break;
    }
    case 'research.intel-report': {
      expectedArtifactTypes = ['intel_research_report'];
      const report = readableArtifact(artifacts, 'intel_research_report')?.data;
      valid = Boolean(report?.conclusion && Array.isArray(report.sources) && report.sources.length);
      break;
    }
    case 'office.briefing-package': {
      expectedArtifactTypes = ['office_briefing_package'];
      const report = readableArtifact(artifacts, 'office_briefing_package')?.data;
      valid = Boolean(report?.summary && report.markdown);
      break;
    }
    case 'office.presentation-package': {
      expectedArtifactTypes = ['office_presentation_source'];
      const artifact = readableArtifact(artifacts, 'office_presentation_source');
      valid = Boolean(artifact?.location && artifact.validation?.structuralQaPassed === true);
      break;
    }
    case 'office.knowledge-summary': {
      expectedArtifactTypes = ['knowledge_summary_note'];
      valid = Boolean(readableArtifact(artifacts, 'knowledge_summary_note')?.location);
      break;
    }
    case 'content.video-benchmark-analysis': {
      expectedArtifactTypes = ['video_content_analysis_report'];
      valid = artifacts.some((artifact) => isVerifiedVideoAnalysisArtifact(task, artifact));
      break;
    }
    case 'content.platform-draft': {
      expectedArtifactTypes = ['platform_content_draft'];
      valid = Boolean(readableArtifact(artifacts, 'platform_content_draft')?.data?.drafts?.length);
      break;
    }
    case 'content.video-script-package': {
      expectedArtifactTypes = ['video_script_package'];
      valid = Boolean(readableArtifact(artifacts, 'video_script_package')?.data?.fullScript);
      break;
    }
    case 'content.performance-review': {
      expectedArtifactTypes = ['content_performance_report'];
      valid = Boolean(readableArtifact(artifacts, 'content_performance_report')?.data?.metrics);
      break;
    }
    case 'media.transcribe-and-refine': {
      expectedArtifactTypes = ['xiaod_media_delivery'];
      const delivery = readableArtifact(artifacts, 'xiaod_media_delivery')?.data;
      valid = Boolean(delivery?.larkUrl
        && delivery.larkPermissionGranted === true
        && delivery.currentTranscriptDelivered !== false);
      break;
    }
    default:
      valid = artifacts.some(isReadableArtifact);
  }

  return {
    valid,
    specialized: SPECIALIZED_COMPLETION_TYPES.has(taskType),
    expectedArtifactTypes,
    reason:valid
      ? null
      : expectedArtifactTypes.length
        ? `任务缺少通过完成门禁的 ${expectedArtifactTypes.join(' / ')} 产物。`
        : '任务缺少通过可读性门禁的产物。',
  };
}

export function isVerifiedVideoAnalysisArtifact(task, artifact) {
  if (artifact?.type !== 'video_content_analysis_report' || !isReadableArtifact(artifact)) return false;
  const validation = artifact.validation || {};
  const data = artifact.data || {};
  if (!Array.isArray(data.modules) || data.modules.length === 0) return false;
  const expectedIntent = resolveAnalysisIntent(task?.input || {}).analysisIntent;
  const reportVersion = validation.reportVersion || data.reportVersion;
  if (reportVersion === 'video-analysis/v2') {
    if (validation.modeStructurePassed !== true || validation.claimsEvidenceLinked !== true) return false;
    if (validation.reportVersion !== 'video-analysis/v2' || data.reportVersion !== 'video-analysis/v2') return false;
    if (!expectedIntent || validation.analysisIntent !== expectedIntent || data.analysisIntent !== expectedIntent) return false;
    if (task?.input?.evidenceMode === 'formal' && validation.formalSourceConfirmed !== true) return false;
    if (task?.input?.evidenceMode === 'formal' && expectedIntent === 'deep') {
      return validation.semanticValidationPassed === true;
    }
    return true;
  }
  const formalFullAnalysis = task?.input?.evidenceMode === 'formal' && task?.input?.depth === 'full';
  if (!formalFullAnalysis) return validation.modeStructurePassed !== false;
  if (expectedIntent === 'deep') return validation.semanticValidationPassed === true;
  return validation.modeStructurePassed === true;
}

export function isReadableArtifact(artifact) {
  return artifact?.validation?.exists === true
    && artifact.validation.readable === true
    && artifact.validation.nonEmpty === true;
}

function readableArtifact(artifacts, type) {
  return artifacts.find((artifact) => artifact?.type === type && isReadableArtifact(artifact));
}
