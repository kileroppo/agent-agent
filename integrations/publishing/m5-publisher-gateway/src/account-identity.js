import crypto from 'node:crypto';
import { M5_PLATFORM_IDS } from '@agent-army/m5-contracts';
import { coded } from './policy.js';

export const PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA =
  'agent.army/publisher-account-identity-verifier/v1';

const HASH = /^sha256:[0-9a-f]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export function validateAccountIdentityVerifier(verifier) {
  if (
    verifier?.contract?.schemaVersion !== PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA
    || verifier?.contract?.deterministic !== true
    || verifier?.contract?.source !== 'paperclip'
    || typeof verifier?.verify !== 'function'
  ) {
    throw coded(
      'publisher_account_identity_verifier_required',
      '抖音官方 connector 必须注入由 Paperclip 背书的确定性账号身份核验器。',
    );
  }
  return verifier;
}

export async function verifyDouyinAccountIdentity({
  verifier,
  accountRef,
  openId,
} = {}) {
  validateAccountIdentityVerifier(verifier);
  const normalizedAccountRef = String(accountRef || '');
  const normalizedOpenId = String(openId || '');
  if (!REFERENCE.test(normalizedAccountRef) || !normalizedOpenId) {
    throw accountMismatch();
  }
  const providerIdentity = Object.freeze({
    kind:'open_id_sha256',
    value:`sha256:${crypto.createHash('sha256').update(normalizedOpenId).digest('hex')}`,
  });
  const request = Object.freeze({
    platform:M5_PLATFORM_IDS.DOUYIN,
    accountRef:normalizedAccountRef,
    providerIdentity,
  });
  let result;
  try {
    result = await verifier.verify(request);
  } catch {
    throw accountMismatch();
  }
  if (!validVerificationResult(result, request)) {
    throw accountMismatch();
  }
  return Object.freeze({
    platform:M5_PLATFORM_IDS.DOUYIN,
    accountRef:normalizedAccountRef,
    providerIdentity,
    verificationRef:String(result.verificationRef),
  });
}

function validVerificationResult(result, request) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const allowed = new Set([
    'verified',
    'platform',
    'accountRef',
    'providerIdentity',
    'verificationRef',
  ]);
  if (Object.keys(result).some((key) => !allowed.has(key))) return false;
  const identity = result.providerIdentity;
  return result.verified === true
    && result.platform === request.platform
    && result.accountRef === request.accountRef
    && identity?.kind === request.providerIdentity.kind
    && identity?.value === request.providerIdentity.value
    && HASH.test(String(identity?.value || ''))
    && String(result.verificationRef || '').startsWith('paperclip:');
}

function accountMismatch() {
  return coded(
    'account_mismatch',
    'Paperclip 无法确认抖音 accountRef 与当前授权身份一致；平台 HTTP 未调用。',
  );
}
