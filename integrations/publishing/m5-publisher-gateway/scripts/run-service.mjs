#!/usr/bin/env node
import { createPublisherGatewayServiceFromEnv } from '../src/service.js';

let service;
try {
  service = createPublisherGatewayServiceFromEnv(process.env);
  const address = await service.listen();
  process.stdout.write(`${JSON.stringify({
    event:'publisher_gateway_listening',
    ...address,
  })}\n`);
} catch (error) {
  process.stderr.write(`${String(error?.code || 'publisher_service_start_failed')}: ${String(error?.message || error)}\n`);
  process.exit(1);
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await service?.close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
