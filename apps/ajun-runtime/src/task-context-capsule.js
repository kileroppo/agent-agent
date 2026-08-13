import { presentTask } from './task-presentation.js';

export const TASK_CONTEXT_CAPSULE_SCHEMA_VERSION = 'agent.army/task-context-capsule/v1';

export function buildTaskContextCapsule(task = {}, { approvals = [] } = {}) {
  const presentation = presentTask(task, { approvals });
  const artifacts = (Array.isArray(task.artifactRefs) ? task.artifactRefs : [])
    .filter(isAdoptedArtifact)
    .slice(0, 10);
  return Object.freeze({
    schemaVersion:TASK_CONTEXT_CAPSULE_SCHEMA_VERSION,
    taskId:text(task.taskId, 128),
    taskType:text(task.taskType, 120),
    status:text(task.status, 60),
    goal:text(task.input?.description || task.input?.title || task.title, 300),
    result:taskResult(task, presentation.summary),
    adoptedArtifactRefs:artifacts.map(artifactReference),
    keyDecisions:taskDecisions(task).slice(0, 5),
    unfinishedItems:unfinishedItems(task).slice(0, 5),
    nextAction:text(presentation.nextAction, 300),
    evidenceRefs:artifacts.map(evidenceReference).filter(Boolean).slice(0, 10),
    updatedAt:iso(task.updatedAt || task.createdAt),
  });
}

function isAdoptedArtifact(artifact) {
  return artifact?.validation?.exists === true
    && artifact?.validation?.nonEmpty === true
    && artifact?.validation?.readable !== false;
}

function artifactReference(artifact) {
  return Object.freeze({
    artifactId:text(artifact.artifactId, 160) || null,
    type:text(artifact.type, 120) || null,
    title:text(artifact.title, 200) || null,
    checksum:text(artifact.checksum, 160) || null,
    location:safeReference(artifact.location),
  });
}

function evidenceReference(artifact) {
  return text(artifact.artifactId || artifact.checksum || artifact.location, 240) || null;
}

function taskResult(task, fallback) {
  const artifacts = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
  const summary = artifacts
    .filter(isAdoptedArtifact)
    .map((artifact) => artifact?.data?.summary || artifact?.data?.resultSummary)
    .find(Boolean);
  return text(summary || task.result?.summary || fallback, 500);
}

function taskDecisions(task) {
  const context = task.input?.context || {};
  return strings(context.keyDecisions || context.decisions, 5, 300);
}

function unfinishedItems(task) {
  const context = task.input?.context || {};
  const explicit = strings(context.unfinishedItems || context.openItems, 5, 300);
  if (explicit.length) return explicit;
  const error = text(task.error?.userMessage || task.error?.message, 300);
  return error ? [error] : [];
}

function strings(value, maxItems, maxLength) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => text(item, maxLength))
    .filter(Boolean))].slice(0, maxItems);
}

function safeReference(value) {
  const candidate = text(value, 500);
  if (!candidate || /(?:token|cookie|secret|password|authorization)=/i.test(candidate)) return null;
  return candidate;
}

function text(value, limit) {
  return String(value || '')
    .replace(/\b(authorization|cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已脱敏]')
    .replace(/([?&](?:token|key|secret|signature|sig|code)=)[^&#\s]+/gi, '$1[已脱敏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function iso(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
