import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyVersionLockedFile,
  rollbackVersionLockedFile,
} from './paperclip-2026-722-binary-rpc.mjs';

export const PAPERCLIP_VERSION = '2026.722.0';
export const RECOVERY_APPROVAL_KIND = 'metric_recovery_authorization_v1';
export const RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256 =
  'bcb94462617c9c5e199b7af0da7f985d96470d56483434ebae9cde2bf4924a89';
export const RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256 =
  '30722c0bec8a53d4ce484df88ba91f4f4a4813f551be8a48db541ca6fe482dfd';
export const RECOVERY_APPROVAL_BACKUP_SUFFIX =
  '.agent-army-paperclip-2026.722.0-recovery-approval.bak';
const UUID_PATTERN =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

const ROUTE_RELATIVE_PATH = '@paperclipai/server/dist/routes/approvals.js';
const IMPORT_ANCHOR = `import { Router } from "express";
import { eq } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";`;
const IMPORT_PATCH = `import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, ne, sql } from "drizzle-orm";
import { approvals, heartbeatRuns, issueApprovals } from "@paperclipai/db";`;
const ERROR_IMPORT_ANCHOR =
  'import { redactEventPayload } from "../redaction.js";';
const ERROR_IMPORT_PATCH = `${ERROR_IMPORT_ANCHOR}
import { conflict, forbidden, unprocessable } from "../errors.js";`;
const ROUTES_ANCHOR = 'export function approvalRoutes(db, options = {}) {';
const CREATE_NORMALIZATION_ANCHOR = `        const normalizedPayload = approvalInput.type === "hire_agent"
            ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(companyId, approvalInput.payload, { strictMode: strictSecretsMode })
            : approvalInput.payload;`;
const CREATE_NORMALIZATION_PATCH = `        const recoveryPayloadRequested = isRecoveryApprovalPayload(approvalInput.payload);
        if (recoveryPayloadRequested && approvalInput.type !== "request_board_approval")
            throw unprocessable("Recovery authorization must use request_board_approval");
        const recoveryApprovalId = recoveryPayloadRequested ? randomUUID() : null;
        const normalizedPayload = approvalInput.type === "hire_agent"
            ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(companyId, approvalInput.payload, { strictMode: strictSecretsMode })
            : recoveryPayloadRequested
                ? bindRecoveryApprovalPayload(normalizeRecoveryApprovalPayload(approvalInput.payload), recoveryApprovalId)
                : approvalInput.payload;`;
const RESUBMIT_NORMALIZATION_ANCHOR = `        const normalizedPayload = req.body.payload
            ? existing.type === "hire_agent"
                ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(existing.companyId, req.body.payload, { strictMode: strictSecretsMode })
                : req.body.payload
            : undefined;`;
const RESUBMIT_NORMALIZATION_PATCH = `        const recoveryPayloadResubmitted = isRecoveryApprovalPayload(req.body.payload);
        if (recoveryPayloadResubmitted && existing.type !== "request_board_approval")
            throw unprocessable("Recovery authorization must use request_board_approval");
        const normalizedPayload = req.body.payload
            ? existing.type === "hire_agent"
                ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(existing.companyId, req.body.payload, { strictMode: strictSecretsMode })
                : recoveryPayloadResubmitted
                    ? bindRecoveryApprovalPayload(normalizeRecoveryApprovalPayload(req.body.payload), existing.id)
                    : req.body.payload
            : undefined;`;
const CREATE_ID_ANCHOR = `        const approval = await svc.create(companyId, {
            ...approvalInput,`;
const CREATE_ID_PATCH = `        const approval = await svc.create(companyId, {
            ...(recoveryApprovalId ? { id: recoveryApprovalId } : {}),
            ...approvalInput,`;
const ENDPOINT_ANCHOR =
  '    router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {';

const RUNTIME_HELPERS = `// agent-army:paperclip-recovery-approval:v1
const RECOVERY_APPROVAL_KIND = "${RECOVERY_APPROVAL_KIND}";
const RECOVERY_SCOPE_KEYS = ["action", "attemptId", "authorizationId", "campaignId", "collectionKey", "conclusion", "consumerAgentId", "evidenceRef", "issueId", "receiptId"];
const RECOVERY_UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const RECOVERY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
function readRecoveryString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function canonicalRecoveryJson(value) {
    if (value === null)
        return "null";
    if (typeof value === "string" || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw unprocessable("Recovery approval scope must contain finite JSON numbers");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return \`[\${value.map((item) => canonicalRecoveryJson(item)).join(",")}]\`;
    if (value && typeof value === "object") {
        return \`{\${Object.keys(value).sort().map((key) => \`\${JSON.stringify(key)}:\${canonicalRecoveryJson(value[key])}\`).join(",")}}\`;
    }
    throw unprocessable("Recovery approval scope must be JSON serializable");
}
function recoveryScopeHash(scope) {
    return \`sha256:\${createHash("sha256").update(canonicalRecoveryJson(scope)).digest("hex")}\`;
}
function recoveryAuthorizationId(approvalId) {
    return \`paperclip:approval:\${approvalId}:recovery\`;
}
function isRecoveryApprovalPayload(payload) {
    return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
        payload.governanceKind === RECOVERY_APPROVAL_KIND);
}
function normalizeRecoveryApprovalPayload(payload) {
    if (!isRecoveryApprovalPayload(payload))
        throw unprocessable("Recovery approval governance kind is invalid");
    const scope = payload.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
        throw unprocessable("Recovery approval scope must be an object");
    const scopeKeys = Object.keys(scope).sort();
    if (scopeKeys.length !== RECOVERY_SCOPE_KEYS.length ||
        scopeKeys.some((key, index) => key !== RECOVERY_SCOPE_KEYS[index])) {
        throw unprocessable("Recovery approval scope contains missing or unsupported fields");
    }
    for (const key of RECOVERY_SCOPE_KEYS) {
        if (!readRecoveryString(scope[key]))
            throw unprocessable(\`Recovery approval scope is missing \${key}\`);
    }
    if (scope.action !== "publisher.reconcile_stale_attempt")
        throw unprocessable("Recovery approval action is outside the stale reconcile boundary");
    if (!["no_external_effect", "external_effect_verified"].includes(scope.conclusion))
        throw unprocessable("Recovery approval conclusion is invalid");
    for (const key of ["campaignId", "receiptId", "issueId", "consumerAgentId"]) {
        if (!RECOVERY_UUID_PATTERN.test(scope[key]))
            throw unprocessable(\`Recovery approval scope \${key} must be a UUID\`);
    }
    for (const key of ["attemptId", "authorizationId", "evidenceRef"]) {
        if (!RECOVERY_REF_PATTERN.test(scope[key]))
            throw unprocessable(\`Recovery approval scope \${key} must be a safe reference\`);
    }
    const collectionMatch = scope.collectionKey.match(/^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):(2h|24h|72h)$/i);
    if (!collectionMatch || collectionMatch[1].toLowerCase() !== scope.receiptId.toLowerCase())
        throw unprocessable("Recovery approval collectionKey must match receiptId and a fixed checkpoint");
    const expiresAtMs = Date.parse(payload.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now())
        throw unprocessable("Recovery approval expiresAt must be a future timestamp");
    const canonicalScope = JSON.parse(canonicalRecoveryJson(scope));
    canonicalScope.campaignId = canonicalScope.campaignId.toLowerCase();
    canonicalScope.receiptId = canonicalScope.receiptId.toLowerCase();
    canonicalScope.issueId = canonicalScope.issueId.toLowerCase();
    canonicalScope.consumerAgentId = canonicalScope.consumerAgentId.toLowerCase();
    canonicalScope.collectionKey = \`\${canonicalScope.receiptId}:\${collectionMatch[2]}\`;
    return {
        ...payload,
        governanceKind: RECOVERY_APPROVAL_KIND,
        scope: canonicalScope,
        scopeHash: recoveryScopeHash(canonicalScope),
        expiresAt: new Date(expiresAtMs).toISOString(),
        revokedAt: null,
        revokedByUserId: null,
        consumedAt: null,
        consumedByRunId: null,
        consumedByAgentId: null,
    };
}
function bindRecoveryApprovalPayload(payload, approvalId) {
    const scope = {
        ...payload.scope,
        authorizationId: recoveryAuthorizationId(approvalId),
    };
    return {
        ...payload,
        scope,
        scopeHash: recoveryScopeHash(scope),
    };
}
function recoveryPayloadState(payload, input) {
    if (!isRecoveryApprovalPayload(payload))
        return { action: "deny", reason: "kind" };
    if (payload.scopeHash !== input.scopeHash)
        return { action: "deny", reason: "scope" };
    if (readRecoveryString(payload.revokedAt))
        return { action: "deny", reason: "revoked" };
    if (readRecoveryString(payload.consumedAt) || readRecoveryString(payload.consumedByRunId)) {
        return payload.consumedByRunId === input.runId &&
            payload.consumedByAgentId === input.agentId
            ? { action: "replay" }
            : { action: "deny", reason: "consumed" };
    }
    const expiresAtMs = Date.parse(payload.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.now.getTime())
        return { action: "deny", reason: "expired" };
    return { action: "apply" };
}
function recoveryRevokeState(payload) {
    if (!isRecoveryApprovalPayload(payload))
        return { action: "deny", reason: "kind" };
    if (readRecoveryString(payload.consumedAt) || readRecoveryString(payload.consumedByRunId))
        return { action: "deny", reason: "consumed" };
    if (readRecoveryString(payload.revokedAt))
        return { action: "replay" };
    return { action: "apply" };
}
function recoveryRunMatchesScope(run, input) {
    const context = run?.contextSnapshot;
    const runIssueId = context && typeof context === "object" && !Array.isArray(context)
        ? readRecoveryString(context.issueId) ?? readRecoveryString(context.taskId)
        : null;
    return Boolean(run &&
        run.id === input.runId &&
        run.companyId === input.companyId &&
        run.agentId === input.agentId &&
        runIssueId === input.issueId);
}
function recoveryLinkMatchesScope(link, input) {
    return Boolean(link &&
        link.companyId === input.companyId &&
        link.approvalId === input.approvalId &&
        link.issueId === input.issueId);
}
`;

const ENDPOINT_PATCH = `    router.post("/approvals/:id/recovery-authorizations/consume", async (req, res) => {
        const id = req.params.id;
        const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
        if (!existing)
            return;
        if (!(await assertApprovalAccessAllowed(req, res, existing.companyId)))
            return;
        if (existing.type !== "request_board_approval" || !isRecoveryApprovalPayload(existing.payload))
            throw unprocessable("Approval is not a metric recovery authorization");
        if (req.actor.type !== "agent" || req.actor.source !== "agent_jwt" ||
            !req.actor.runId || !req.actor.agentId) {
            throw forbidden("Recovery authorization consume requires an authenticated agent Run JWT");
        }
        const runId = req.actor.runId;
        const agentId = req.actor.agentId;
        const requestScope = req.body?.scope;
        if (!requestScope || typeof requestScope !== "object" || Array.isArray(requestScope))
            throw unprocessable("Recovery authorization consume requires an exact scope");
        const scopeHash = recoveryScopeHash(requestScope);
        const issueId = readRecoveryString(requestScope.issueId);
        if (!issueId || readRecoveryString(requestScope.consumerAgentId) !== agentId)
            throw forbidden("Recovery authorization scope does not match the consuming agent and issue");
        const result = await db.transaction(async (tx) => {
            await tx.execute(sql\`select pg_advisory_xact_lock(hashtextextended(\${\`\${existing.companyId}:\${scopeHash}\`}, 0))\`);
            const approval = await tx
                .select()
                .from(approvals)
                .where(and(eq(approvals.id, id), eq(approvals.companyId, existing.companyId)))
                .for("update")
                .then((rows) => rows[0] ?? null);
            if (!approval)
                throw conflict("Recovery authorization disappeared before consume");
            if (approval.status !== "approved")
                throw conflict("Recovery authorization is not approved");
            const state = recoveryPayloadState(approval.payload, {
                scopeHash,
                runId,
                agentId,
                now: new Date(),
            });
            if (state.action === "deny")
                throw conflict(\`Recovery authorization cannot be consumed: \${state.reason}\`);
            const run = await tx
                .select({
                id: heartbeatRuns.id,
                companyId: heartbeatRuns.companyId,
                agentId: heartbeatRuns.agentId,
                contextSnapshot: heartbeatRuns.contextSnapshot,
            })
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, runId))
                .limit(1)
                .for("share")
                .then((rows) => rows[0] ?? null);
            if (!recoveryRunMatchesScope(run, {
                runId,
                companyId: approval.companyId,
                agentId,
                issueId,
            }))
                throw forbidden("Recovery authorization run does not match company, agent, and issue");
            const linkedIssue = await tx
                .select({
                companyId: issueApprovals.companyId,
                approvalId: issueApprovals.approvalId,
                issueId: issueApprovals.issueId,
            })
                .from(issueApprovals)
                .where(and(eq(issueApprovals.approvalId, approval.id), eq(issueApprovals.issueId, issueId)))
                .limit(1)
                .for("update")
                .then((rows) => rows[0] ?? null);
            if (!recoveryLinkMatchesScope(linkedIssue, {
                companyId: approval.companyId,
                approvalId: approval.id,
                issueId,
            }))
                throw forbidden("Recovery authorization is not linked to the consuming issue");
            if (state.action === "replay")
                return { approval, applied: false, replayed: true };
            const duplicate = await tx
                .select({ id: approvals.id })
                .from(approvals)
                .where(and(eq(approvals.companyId, approval.companyId), ne(approvals.id, approval.id), eq(approvals.type, "request_board_approval"), sql\`\${approvals.payload}->>'governanceKind' = \${RECOVERY_APPROVAL_KIND}\`, sql\`\${approvals.payload}->>'scopeHash' = \${scopeHash}\`, sql\`coalesce(\${approvals.payload}->>'consumedAt', \${approvals.payload}->>'consumedByRunId') is not null\`))
                .limit(1)
                .then((rows) => rows[0] ?? null);
            if (duplicate)
                throw conflict("An equivalent recovery authorization has already been consumed");
            const now = new Date();
            const [updated] = await tx
                .update(approvals)
                .set({
                payload: {
                    ...approval.payload,
                    consumedAt: now.toISOString(),
                    consumedByRunId: runId,
                    consumedByAgentId: agentId,
                },
                updatedAt: now,
            })
                .where(and(eq(approvals.id, approval.id), eq(approvals.status, "approved"), sql\`\${approvals.payload}->>'governanceKind' = \${RECOVERY_APPROVAL_KIND}\`, sql\`\${approvals.payload}->>'scopeHash' = \${scopeHash}\`, sql\`coalesce(\${approvals.payload}->>'revokedAt', '') = ''\`, sql\`coalesce(\${approvals.payload}->>'consumedAt', \${approvals.payload}->>'consumedByRunId') is null\`, sql\`(\${approvals.payload}->>'expiresAt')::timestamptz > current_timestamp\`))
                .returning();
            if (!updated)
                throw conflict("Recovery authorization lost the consume race");
            return { approval: updated, applied: true, replayed: false };
        });
        res.json({
            approval: redactApprovalPayload(result.approval),
            applied: result.applied,
            replayed: result.replayed,
        });
    });
    router.post("/approvals/:id/recovery-authorizations/revoke", async (req, res) => {
        assertBoard(req);
        const id = req.params.id;
        const existing = await requireApprovalAccess(req, id);
        if (!existing) {
            res.status(404).json({ error: "Approval not found" });
            return;
        }
        if (existing.type !== "request_board_approval" || !isRecoveryApprovalPayload(existing.payload))
            throw unprocessable("Approval is not a metric recovery authorization");
        const scopeHash = readRecoveryString(existing.payload.scopeHash);
        if (!scopeHash)
            throw unprocessable("Recovery authorization scopeHash is missing");
        const revokedByUserId = req.actor.userId ?? "board";
        const result = await db.transaction(async (tx) => {
            await tx.execute(sql\`select pg_advisory_xact_lock(hashtextextended(\${\`\${existing.companyId}:\${scopeHash}\`}, 0))\`);
            const approval = await tx
                .select()
                .from(approvals)
                .where(and(eq(approvals.id, id), eq(approvals.companyId, existing.companyId)))
                .for("update")
                .then((rows) => rows[0] ?? null);
            if (!approval)
                throw conflict("Recovery authorization disappeared before revoke");
            const state = recoveryRevokeState(approval.payload);
            if (state.action === "deny")
                throw conflict(\`Recovery authorization cannot be revoked: \${state.reason}\`);
            if (state.action === "replay")
                return { approval, applied: false, replayed: true };
            const now = new Date();
            const [updated] = await tx
                .update(approvals)
                .set({
                payload: {
                    ...approval.payload,
                    revokedAt: now.toISOString(),
                    revokedByUserId,
                },
                updatedAt: now,
            })
                .where(and(eq(approvals.id, approval.id), sql\`\${approvals.payload}->>'governanceKind' = \${RECOVERY_APPROVAL_KIND}\`, sql\`coalesce(\${approvals.payload}->>'revokedAt', '') = ''\`, sql\`coalesce(\${approvals.payload}->>'consumedAt', \${approvals.payload}->>'consumedByRunId') is null\`))
                .returning();
            if (!updated)
                throw conflict("Recovery authorization lost the revoke race");
            return { approval: updated, applied: true, replayed: false };
        });
        res.json({
            approval: redactApprovalPayload(result.approval),
            applied: result.applied,
            replayed: result.replayed,
        });
    });
${ENDPOINT_ANCHOR}`;

export function canonicalRecoveryScope(value) {
  return canonicalJson(value);
}

export function hashRecoveryScope(scope) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalRecoveryScope(scope))
    .digest('hex')}`;
}

export function normalizeRecoveryApprovalPayload(payload, { now = new Date() } = {}) {
  if (!isRecord(payload) || payload.governanceKind !== RECOVERY_APPROVAL_KIND) {
    throw recoveryError('Recovery approval governance kind 无效。');
  }
  if (!isRecord(payload.scope)) {
    throw recoveryError('Recovery approval scope 必须是对象。');
  }
  const scopeKeys = [
    'action',
    'attemptId',
    'authorizationId',
    'campaignId',
    'collectionKey',
    'conclusion',
    'consumerAgentId',
    'evidenceRef',
    'issueId',
    'receiptId',
  ];
  const actualScopeKeys = Object.keys(payload.scope).sort();
  if (
    actualScopeKeys.length !== scopeKeys.length
    || actualScopeKeys.some((key, index) => key !== scopeKeys[index])
  ) {
    throw recoveryError('Recovery approval scope 存在缺失或未授权字段。');
  }
  for (const key of scopeKeys) {
    if (!nonEmptyString(payload.scope[key])) {
      throw recoveryError(`Recovery approval scope 缺少 ${key}。`);
    }
  }
  if (payload.scope.action !== 'publisher.reconcile_stale_attempt') {
    throw recoveryError('Recovery approval action 越界。');
  }
  if (
    !['no_external_effect', 'external_effect_verified']
      .includes(payload.scope.conclusion)
  ) {
    throw recoveryError('Recovery approval conclusion 无效。');
  }
  for (const key of ['campaignId', 'receiptId', 'issueId', 'consumerAgentId']) {
    if (!UUID_PATTERN.test(payload.scope[key])) {
      throw recoveryError(`Recovery approval scope ${key} 必须是 UUID。`);
    }
  }
  for (const key of ['attemptId', 'authorizationId', 'evidenceRef']) {
    if (!SAFE_REF_PATTERN.test(payload.scope[key])) {
      throw recoveryError(`Recovery approval scope ${key} 必须是安全引用。`);
    }
  }
  const collectionMatch = payload.scope.collectionKey.match(
    /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):(2h|24h|72h)$/i,
  );
  if (
    !collectionMatch
    || collectionMatch[1].toLowerCase()
      !== payload.scope.receiptId.toLowerCase()
  ) {
    throw recoveryError(
      'Recovery approval collectionKey 必须匹配 receiptId 与固定检查点。',
    );
  }
  const nowMs = validDate(now).getTime();
  const expiresAtMs = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw recoveryError('Recovery approval expiresAt 必须是未来时间。');
  }
  const scope = JSON.parse(canonicalRecoveryScope(payload.scope));
  scope.campaignId = scope.campaignId.toLowerCase();
  scope.receiptId = scope.receiptId.toLowerCase();
  scope.issueId = scope.issueId.toLowerCase();
  scope.consumerAgentId = scope.consumerAgentId.toLowerCase();
  scope.collectionKey = `${scope.receiptId}:${collectionMatch[2]}`;
  return {
    ...structuredClone(payload),
    governanceKind:RECOVERY_APPROVAL_KIND,
    scope,
    scopeHash:hashRecoveryScope(scope),
    expiresAt:new Date(expiresAtMs).toISOString(),
    revokedAt:null,
    revokedByUserId:null,
    consumedAt:null,
    consumedByRunId:null,
    consumedByAgentId:null,
  };
}

export function bindRecoveryApprovalPayload(payload, approvalId) {
  const normalizedApprovalId = nonEmptyString(approvalId);
  if (!normalizedApprovalId || !UUID_PATTERN.test(normalizedApprovalId)) {
    throw recoveryError('Recovery approval id 必须是 UUID。');
  }
  const scope = {
    ...structuredClone(payload.scope),
    authorizationId:`paperclip:approval:${normalizedApprovalId.toLowerCase()}:recovery`,
  };
  return {
    ...structuredClone(payload),
    scope,
    scopeHash:hashRecoveryScope(scope),
  };
}

export function decideRecoveryConsume(payload, {
  scopeHash,
  runId,
  agentId,
  now = new Date(),
} = {}) {
  if (!isRecord(payload) || payload.governanceKind !== RECOVERY_APPROVAL_KIND) {
    return { action:'deny', reason:'kind' };
  }
  if (payload.scopeHash !== scopeHash) return { action:'deny', reason:'scope' };
  if (nonEmptyString(payload.revokedAt)) return { action:'deny', reason:'revoked' };
  if (nonEmptyString(payload.consumedAt) || nonEmptyString(payload.consumedByRunId)) {
    return payload.consumedByRunId === runId && payload.consumedByAgentId === agentId
      ? { action:'replay' }
      : { action:'deny', reason:'consumed' };
  }
  const expiresAtMs = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= validDate(now).getTime()) {
    return { action:'deny', reason:'expired' };
  }
  return { action:'apply' };
}

export function decideRecoveryRevoke(payload) {
  if (!isRecord(payload) || payload.governanceKind !== RECOVERY_APPROVAL_KIND) {
    return { action:'deny', reason:'kind' };
  }
  if (nonEmptyString(payload.consumedAt) || nonEmptyString(payload.consumedByRunId)) {
    return { action:'deny', reason:'consumed' };
  }
  if (nonEmptyString(payload.revokedAt)) return { action:'replay' };
  return { action:'apply' };
}

export function decideRecoveryConsumeBinding({
  actor,
  approval,
  scope,
  run,
  link,
} = {}) {
  if (
    actor?.type !== 'agent'
    || actor?.source !== 'agent_jwt'
    || !nonEmptyString(actor.runId)
    || !nonEmptyString(actor.agentId)
  ) {
    return { allowed:false, reason:'run_jwt' };
  }
  if (
    !isRecord(approval)
    || !nonEmptyString(approval.id)
    || !nonEmptyString(approval.companyId)
    || actor.companyId !== approval.companyId
  ) {
    return { allowed:false, reason:'company' };
  }
  if (
    !isRecord(scope)
    || scope.consumerAgentId !== actor.agentId
    || !nonEmptyString(scope.issueId)
  ) {
    return { allowed:false, reason:'scope' };
  }
  const context = isRecord(run?.contextSnapshot) ? run.contextSnapshot : {};
  const runIssueId = nonEmptyString(context.issueId) || nonEmptyString(context.taskId);
  if (
    run?.id !== actor.runId
    || run?.companyId !== approval.companyId
    || run?.agentId !== actor.agentId
    || runIssueId !== scope.issueId
  ) {
    return { allowed:false, reason:'run' };
  }
  if (
    link?.companyId !== approval.companyId
    || link?.approvalId !== approval.id
    || link?.issueId !== scope.issueId
  ) {
    return { allowed:false, reason:'issue_link' };
  }
  return { allowed:true };
}

export function buildRecoveryApprovalRouteSource(source) {
  let patched = String(source);
  patched = replaceExactly(patched, IMPORT_ANCHOR, IMPORT_PATCH);
  patched = replaceExactly(patched, ERROR_IMPORT_ANCHOR, ERROR_IMPORT_PATCH);
  patched = replaceExactly(patched, ROUTES_ANCHOR, `${RUNTIME_HELPERS}${ROUTES_ANCHOR}`);
  patched = replaceExactly(
    patched,
    CREATE_NORMALIZATION_ANCHOR,
    CREATE_NORMALIZATION_PATCH,
  );
  patched = replaceExactly(patched, CREATE_ID_ANCHOR, CREATE_ID_PATCH);
  patched = replaceExactly(
    patched,
    RESUBMIT_NORMALIZATION_ANCHOR,
    RESUBMIT_NORMALIZATION_PATCH,
  );
  patched = replaceExactly(patched, ENDPOINT_ANCHOR, ENDPOINT_PATCH);
  return patched;
}

export function patchRecoveryApprovalRouteSource(source) {
  const text = String(source);
  const currentSha = sha256(text);
  if (currentSha === RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256) return text;
  if (currentSha !== RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256) {
    throw recoveryError(
      'Paperclip approvals route源码SHA或补丁锚点不匹配，拒绝修改未知版本。',
    );
  }
  const patched = buildRecoveryApprovalRouteSource(text);
  if (sha256(patched) !== RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256) {
    throw recoveryError('Paperclip approvals route目标SHA不匹配，拒绝写入。');
  }
  return patched;
}

export async function resolveRecoveryApprovalTarget({ paperclipEntry }) {
  const paperclipRoot = await packageRootForEntry(paperclipEntry, 'paperclipai');
  const paperclipPackage = await readPackage(path.join(paperclipRoot, 'package.json'));
  if (paperclipPackage.version !== PAPERCLIP_VERSION) {
    throw recoveryError(
      `只允许 Paperclip ${PAPERCLIP_VERSION}，当前为 ${paperclipPackage.version || 'unknown'}。`,
    );
  }
  const nodeModulesRoot = path.dirname(paperclipRoot);
  const serverRoot = path.join(nodeModulesRoot, '@paperclipai', 'server');
  const serverPackage = await readPackage(path.join(serverRoot, 'package.json'));
  if (
    serverPackage.name !== '@paperclipai/server'
    || serverPackage.version !== PAPERCLIP_VERSION
  ) {
    throw recoveryError('Paperclip server包名或版本不匹配。');
  }
  const routeFile = path.join(nodeModulesRoot, ROUTE_RELATIVE_PATH);
  await assertInside(serverRoot, routeFile);
  return {
    paperclipRoot,
    serverRoot,
    routeFile,
    backupFile:`${routeFile}${RECOVERY_APPROVAL_BACKUP_SUFFIX}`,
  };
}

export async function applyRecoveryApprovalPatch(options) {
  const targets = await resolveRecoveryApprovalTarget(options);
  const result = await applyVersionLockedFile({
    file:targets.routeFile,
    backupFile:targets.backupFile,
    originalSha:RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256,
    patchedSha:RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256,
    patch:(current) => Buffer.from(
      patchRecoveryApprovalRouteSource(current.toString('utf8')),
    ),
  });
  return { ...result, ...targets };
}

export async function rollbackRecoveryApprovalPatch(options) {
  const targets = await resolveRecoveryApprovalTarget(options);
  const result = await rollbackVersionLockedFile({
    file:targets.routeFile,
    backupFile:targets.backupFile,
    originalSha:RECOVERY_APPROVAL_ROUTE_ORIGINAL_SHA256,
    patchedSha:RECOVERY_APPROVAL_ROUTE_PATCHED_SHA256,
  });
  return { ...result, ...targets };
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw recoveryError('Recovery approval scope 只能包含有限 JSON 数字。');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw recoveryError('Recovery approval scope 必须是有限 JSON。');
}

function replaceExactly(source, anchor, replacement) {
  if (occurrences(source, anchor) !== 1) {
    throw recoveryError('Paperclip approvals route源码SHA或补丁锚点不匹配。');
  }
  return source.replace(anchor, replacement);
}

async function packageRootForEntry(entryValue, expectedName) {
  const entry = await fs.realpath(path.resolve(required(
    entryValue,
    `${expectedName}入口缺失。`,
  )));
  let current = path.dirname(entry);
  for (;;) {
    const record = await readPackage(path.join(current, 'package.json'), {
      optional:true,
    });
    if (record?.name === expectedName) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw recoveryError(`入口不属于 ${expectedName} 包。`);
}

async function assertInside(rootValue, fileValue) {
  const root = await fs.realpath(rootValue);
  const file = await fs.realpath(fileValue);
  if (!file.startsWith(`${root}${path.sep}`)) {
    throw recoveryError('兼容补丁目标路径逃逸 Paperclip server 包目录。');
  }
}

async function readPackage(file, { optional = false } = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw recoveryError(`无法读取或解析包元数据：${path.basename(path.dirname(file))}。`);
  }
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw recoveryError('当前时间无效。');
  return date;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function required(value, message) {
  const text = String(value || '').trim();
  if (!text) throw recoveryError(message);
  return text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recoveryError(message) {
  const error = new Error(message);
  error.name = 'PaperclipRecoveryApprovalCompatError';
  return error;
}
