import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA,
  validateAccountIdentityVerifier,
  verifyDouyinAccountIdentity,
} from '../src/index.ts';
import {
  recordingAccountIdentityVerifier,
} from '../test-support/account-identity-verifier.js';

const OPEN_ID = 'douyin-owner-open-id-secret';

test('账号核验器只接受Paperclip背书的确定性contract', () => {
  for (const verifier of [
    null,
    {
      contract:{
        schemaVersion:PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA,
        deterministic:true,
        source:'environment',
      },
      verify:async () => ({ verified:true }),
    },
    {
      contract:{
        schemaVersion:PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA,
        deterministic:false,
        source:'paperclip',
      },
      verify:async () => ({ verified:true }),
    },
  ]) {
    assert.throws(
      () => validateAccountIdentityVerifier(verifier),
      { code:'publisher_account_identity_verifier_required' },
    );
  }
});

test('open_id只以SHA-256送入核验器且不会出现在核验结果', async () => {
  const verifier = recordingAccountIdentityVerifier();
  const result = await verifyDouyinAccountIdentity({
    verifier,
    accountRef:'account:douyin:owner',
    openId:OPEN_ID,
  });
  const expectedHash = `sha256:${crypto.createHash('sha256').update(OPEN_ID).digest('hex')}`;

  assert.deepEqual(verifier.calls, [{
    platform:'douyin',
    accountRef:'account:douyin:owner',
    providerIdentity:{
      kind:'open_id_sha256',
      value:expectedHash,
    },
  }]);
  assert.equal(result.providerIdentity.value, expectedHash);
  assert.equal(JSON.stringify(verifier.calls).includes(OPEN_ID), false);
  assert.equal(JSON.stringify(result).includes(OPEN_ID), false);
});

test('核验器夹带openId字段或返回不匹配身份时统一account_mismatch', async () => {
  const forged = recordingAccountIdentityVerifier();
  forged.verify = async (input) => ({
    verified:true,
    ...structuredClone(input),
    openId:OPEN_ID,
    verificationRef:'paperclip:publisher-account:forged',
  });
  await assert.rejects(
    verifyDouyinAccountIdentity({
      verifier:forged,
      accountRef:'account:douyin:owner',
      openId:OPEN_ID,
    }),
    { code:'account_mismatch' },
  );

  await assert.rejects(
    verifyDouyinAccountIdentity({
      verifier:recordingAccountIdentityVerifier({ verified:false }),
      accountRef:'account:douyin:owner',
      openId:OPEN_ID,
    }),
    { code:'account_mismatch' },
  );
});
