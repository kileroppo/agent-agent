#!/usr/bin/env node

import { createPaperclipLoopbackClient } from './support/paperclip-loopback-client.mjs';
import { PaperclipOperationsHealthCatalog } from './support/paperclip-operations-health-catalog.mjs';

export async function ensureOperationsHealthRoutine({ fetchImpl = fetch } = {}) {
  const client = createPaperclipLoopbackClient({
    apiBase: 'http://127.0.0.1:3100',
    fetchImpl,
    operation: '本机健康巡检安排',
  });
  return new PaperclipOperationsHealthCatalog({ client, companyName:'Agent军团' }).ensureRoutine();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureOperationsHealthRoutine()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
