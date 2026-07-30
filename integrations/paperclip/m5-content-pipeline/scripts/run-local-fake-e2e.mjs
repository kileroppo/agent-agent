globalThis.fetch = async () => {
  throw new Error('M5 本地 Fake E2E 禁止网络请求');
};

const { runM5LocalChaosAcceptance } = await import(
  '../../../../apps/ajun-runtime/src/m5-local-chaos-acceptance.js'
);

const ledger = await runM5LocalChaosAcceptance();
if (ledger?.passed !== true || ledger?.security?.passed !== true) {
  throw new Error('M5 本地 Fake E2E 验收未通过');
}

process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
