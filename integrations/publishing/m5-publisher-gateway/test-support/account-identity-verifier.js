import {
  PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA,
} from '../src/account-identity.ts';

export function recordingAccountIdentityVerifier({
  verified = true,
  error = null,
} = {}) {
  const calls = [];
  return {
    contract:{
      schemaVersion:PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA,
      deterministic:true,
      source:'paperclip',
    },
    calls,
    async verify(input) {
      calls.push(structuredClone(input));
      if (error) throw error;
      return {
        verified,
        platform:input.platform,
        accountRef:input.accountRef,
        providerIdentity:structuredClone(input.providerIdentity),
        verificationRef:'paperclip:publisher-account:test',
      };
    },
  };
}
